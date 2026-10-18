/*!
 * TagPulse AI — Shop Health Audit (pure logic, no DOM, no network)
 *
 * Parses an Etsy "active listings" CSV and runs deterministic, local checks.
 * Exposed as window.TagPulseShopHealthAudit in the browser and through
 * module.exports in Node (tests/shop-health-audit.test.cjs).
 *
 * This file never uses fetch / XMLHttpRequest / FormData / storage, and it
 * only ever returns plain strings and numbers: the UI renders them with
 * textContent. It reports counts from THIS audit's checks only; it does not
 * produce an SEO score or any Etsy ranking, traffic, sales, search-volume or
 * competition figure.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.TagPulseShopHealthAudit = api;
  } else if (root && typeof root === "object" && !(typeof module === "object" && module && module.exports)) {
    root.TagPulseShopHealthAudit = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ------------------------------------------------------------
     Thresholds (deterministic; covered by tests)
     ------------------------------------------------------------ */
  var THRESHOLDS = Object.freeze({
    MAX_FILE_BYTES: 10 * 1024 * 1024,
    TITLE_MAX_CHARS: 140,
    TAG_MAX_CHARS: 20,
    TAG_SLOTS: 13,
    // Similar titles: need at least this many shared MEANINGFUL words AND
    // that share of the shorter title's meaningful words.
    TITLE_SIMILAR_MIN_SHARED: 4,
    TITLE_SIMILAR_MIN_RATIO: 0.75,
    TITLE_SIMILAR_MIN_TERMS: 4,
    // Tag overlap: shared tags must be at least max(MIN_SHARED, 50% of the
    // smaller tag set).
    TAG_OVERLAP_MIN_SHARED: 4,
    TAG_OVERLAP_MIN_RATIO: 0.5,
    // An identical description is only reported together with other
    // duplicate-listing evidence: an exact-duplicate title, a similar title,
    // high tag overlap, or at least this many shared tags / title words.
    DESC_MIN_CHARS: 40,
    DESC_SUPPORT_MIN_SHARED: 3,
    // Performance bounds for cross-listing comparison.
    MAX_POSTING_LIST: 80,          // a tag/word used by more listings than this is not used to find pairs
    MAX_PAIR_UPDATES: 1500000,     // hard ceiling on counting work
    MAX_GROUP_PAIR_MEMBERS: 50,    // members examined per identical-description group
    BIG_TITLE_GROUP: 6,            // identical-title groups larger than this are reported as one group
    MAX_STORED_PAIRS: 500
  });

  // Words that do not make two titles meaningfully alike.
  var TITLE_STOPWORDS = new Set((
    "a an the and or of for to in on at by with without from into over under your you my our their his her him " +
    "them its it is are be this that these those as per one two set pack pcs piece pieces new best top great " +
    "perfect unique gift gifts idea ideas present presents personalized personalised custom customized " +
    "customised handmade made free shipping sale etsy item items" +
    ""
  ).split(/\s+/).filter(Boolean));

  /* ------------------------------------------------------------
     Text helpers
     ------------------------------------------------------------ */
  function charCount(s) {
    return Array.from(String(s == null ? "" : s)).length;
  }

  function collapseSpaces(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  // Tag comparison key: case-insensitive, whitespace collapsed. No stemming,
  // no punctuation stripping (so "dog mom" and "dog moms" stay different).
  function tagKey(s) {
    return collapseSpaces(String(s == null ? "" : s).normalize("NFKC")).toLowerCase();
  }

  // Title / description comparison key: case, punctuation and whitespace
  // differences ignored.
  function textKey(s) {
    return String(s == null ? "" : s)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function meaningfulTerms(title) {
    var seen = Object.create(null);
    var out = [];
    String(title == null ? "" : title)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/['’]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .forEach(function (w) {
        if (!w || w.length < 3 || TITLE_STOPWORDS.has(w) || seen[w]) return;
        seen[w] = true;
        out.push(w);
      });
    return out;
  }

  function shorten(s, max) {
    var chars = Array.from(String(s));
    return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : String(s);
  }

  /* ------------------------------------------------------------
     CSV parsing (RFC-4180 style)
     ------------------------------------------------------------
     Returns { rows, rowNumbers, blankLines, unterminatedQuote }.
       rows[i]        array of trimmed cell strings
       rowNumbers[i]  1-based CSV record number (the header is record 1,
                      blank lines count), i.e. the row a spreadsheet shows
       blankLines     number of completely empty lines skipped
     Handles quoted commas/newlines, "" escapes, CRLF / LF / CR, a UTF-8
     BOM, blank lines and trailing empty cells.
     ------------------------------------------------------------ */
  function parseCsv(text) {
    var s = String(text == null ? "" : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

    var rows = [];
    var rowNumbers = [];
    var row = [];
    var field = "";
    var fieldStarted = false;   // any character (or an opening quote) seen in this field
    var inQuotes = false;
    var recordNo = 1;
    var blankLines = 0;
    var i = 0;
    var n = s.length;

    function endField() {
      row.push(field.trim());
      field = "";
      fieldStarted = false;
    }
    function endRecord() {
      var onlyEmptyField = row.length === 0 && !fieldStarted && field === "";
      if (onlyEmptyField) {
        blankLines++;
      } else {
        endField();
        rows.push(row);
        rowNumbers.push(recordNo);
      }
      row = [];
      field = "";
      fieldStarted = false;
      recordNo++;
    }

    while (i < n) {
      var ch = s.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && !fieldStarted) {
        inQuotes = true; fieldStarted = true; i++; continue;
      }
      if (ch === ",") { endField(); i++; continue; }
      if (ch === "\r") {
        if (s.charAt(i + 1) === "\n") i++;
        endRecord(); i++; continue;
      }
      if (ch === "\n") { endRecord(); i++; continue; }
      field += ch; fieldStarted = true; i++;
    }
    var unterminatedQuote = inQuotes;
    if (fieldStarted || field !== "" || row.length > 0) {
      endField();
      rows.push(row);
      rowNumbers.push(recordNo);
    }
    return { rows: rows, rowNumbers: rowNumbers, blankLines: blankLines, unterminatedQuote: unterminatedQuote };
  }

  /* ------------------------------------------------------------
     Header + tag parsing
     ------------------------------------------------------------ */
  // Lower-case, letters and digits only: "SKU numbers", "Sku_Number(s)" ->
  // "skunumbers" / "skunumbers".
  function normalizeHeader(h) {
    return String(h == null ? "" : h)
      .replace(/^﻿/, "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  var HEADER_ALIASES = {
    title: ["title"],
    description: ["description"],
    tags: ["tags"],
    materials: ["materials"],
    sku: ["sku", "skus", "skunumber", "skunumbers"]
  };

  function findColumns(headerCells) {
    var normalized = headerCells.map(normalizeHeader);
    var out = {};
    Object.keys(HEADER_ALIASES).forEach(function (field) {
      out[field] = -1;
      for (var i = 0; i < normalized.length; i++) {
        if (HEADER_ALIASES[field].indexOf(normalized[i]) !== -1) { out[field] = i; break; }
      }
    });
    return out;
  }

  // Splits an already-parsed Tags cell on commas and newlines.
  function parseTags(cell) {
    return String(cell == null ? "" : cell)
      .split(/[,\r\n]+/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean)
      .map(function (t) { return { text: t, key: tagKey(t) }; });
  }

  /* ------------------------------------------------------------
     Per-listing checks
     ------------------------------------------------------------ */
  function listingChecks(listing, descriptionColumnPresent) {
    var findings = [];
    var T = THRESHOLDS;

    if (!listing.title) {
      findings.push({
        kind: "missing_title", severity: "issue",
        heading: "Missing title",
        evidence: ["The Title cell for CSV row " + listing.row + " is blank."],
        action: "Add a title that describes this item (up to " + T.TITLE_MAX_CHARS + " characters)."
      });
    } else {
      var len = charCount(listing.title);
      if (len > T.TITLE_MAX_CHARS) {
        findings.push({
          kind: "title_too_long", severity: "issue",
          heading: "Title is over " + T.TITLE_MAX_CHARS + " characters",
          evidence: ["The title is " + len + " characters; the limit is " + T.TITLE_MAX_CHARS + "."],
          action: "Shorten the title by at least " + (len - T.TITLE_MAX_CHARS) + " character" + (len - T.TITLE_MAX_CHARS === 1 ? "" : "s") + ", keeping the key product words near the start."
        });
      }
    }

    var tooLong = listing.tags.filter(function (t) { return charCount(t.text) > T.TAG_MAX_CHARS; });
    if (tooLong.length) {
      findings.push({
        kind: "tag_too_long", severity: "issue",
        heading: tooLong.length + " tag" + (tooLong.length === 1 ? "" : "s") + " over " + T.TAG_MAX_CHARS + " characters",
        evidence: tooLong.map(function (t) {
          return "“" + t.text + "” is " + charCount(t.text) + " characters (limit " + T.TAG_MAX_CHARS + ", spaces included).";
        }),
        action: "Reword " + (tooLong.length === 1 ? "this tag" : "these tags") + " so each is " + T.TAG_MAX_CHARS + " characters or fewer."
      });
    }

    var groups = Object.create(null);
    var order = [];
    listing.tags.forEach(function (t) {
      if (!groups[t.key]) { groups[t.key] = []; order.push(t.key); }
      groups[t.key].push(t.text);
    });
    var repeated = order.filter(function (k) { return groups[k].length > 1; });
    if (repeated.length) {
      findings.push({
        kind: "duplicate_tags", severity: "issue",
        heading: "Repeated tag" + (repeated.length === 1 ? "" : "s") + " in this listing",
        evidence: repeated.map(function (k) {
          var variants = groups[k].filter(function (v, i, a) { return a.indexOf(v) === i; });
          return "“" + variants.join("” / “") + "” appears " + groups[k].length + " times.";
        }),
        action: "Each repeat uses a tag slot without adding a different phrase; consider replacing the extra copy with another relevant phrase."
      });
    }

    if (listing.tags.length < T.TAG_SLOTS) {
      var used = listing.tags.length;
      findings.push({
        kind: "fewer_tags", severity: "opportunity",
        heading: "Open tag slots",
        evidence: ["Uses " + used + " of " + T.TAG_SLOTS + " available tag slots."],
        action: "Worth a look: if other relevant search phrases genuinely describe this item, you could use the open slots. Add only tags that truly fit; leave slots empty rather than adding filler."
      });
    }

    if (descriptionColumnPresent && !listing.description) {
      findings.push({
        kind: "blank_description", severity: "issue",
        heading: "Blank description",
        evidence: ["The Description cell for CSV row " + listing.row + " is blank."],
        action: "Add a description that accurately describes this item."
      });
    }
    return findings;
  }

  /* ------------------------------------------------------------
     Cross-listing checks (indexed, bounded)
     ------------------------------------------------------------ */
  function pairKeyOf(a, b, n) { return a < b ? a * n + b : b * n + a; }

  function crossChecks(listings, descriptionColumnPresent) {
    var T = THRESHOLDS;
    var n = listings.length;
    var notes = [];
    var complete = true;

    // ----- indexes -----
    var titleGroups = Object.create(null);
    var tagPostings = Object.create(null);
    var termPostings = Object.create(null);
    var descGroups = Object.create(null);

    listings.forEach(function (l, i) {
      l.titleKey = textKey(l.title);
      l.terms = meaningfulTerms(l.title);
      l.tagKeys = [];
      var seenTag = Object.create(null);
      l.tags.forEach(function (t) {
        if (t.key && !seenTag[t.key]) { seenTag[t.key] = true; l.tagKeys.push(t.key); }
      });
      if (l.titleKey) (titleGroups[l.titleKey] = titleGroups[l.titleKey] || []).push(i);
      l.tagKeys.forEach(function (k) { (tagPostings[k] = tagPostings[k] || []).push(i); });
      if (l.terms.length >= T.TITLE_SIMILAR_MIN_TERMS) {
        l.terms.forEach(function (w) { (termPostings[w] = termPostings[w] || []).push(i); });
      }
      if (descriptionColumnPresent) {
        var dk = textKey(l.description);
        l.descKey = charCount(dk) >= T.DESC_MIN_CHARS ? dk : "";
        if (l.descKey) (descGroups[l.descKey] = descGroups[l.descKey] || []).push(i);
      }
    });

    // ----- counting shared tags / words per pair (bounded) -----
    var updates = 0;
    var budgetHit = false;
    var skippedCommon = 0;

    function countPairs(postings, counts, minListLen) {
      var keys = Object.keys(postings).sort();
      for (var k = 0; k < keys.length; k++) {
        var list = postings[keys[k]];
        if (list.length < 2) continue;
        if (list.length > T.MAX_POSTING_LIST) { skippedCommon++; continue; }
        for (var x = 0; x < list.length; x++) {
          for (var y = x + 1; y < list.length; y++) {
            if (updates >= T.MAX_PAIR_UPDATES) { budgetHit = true; return; }
            updates++;
            var pk = pairKeyOf(list[x], list[y], n);
            counts.set(pk, (counts.get(pk) || 0) + 1);
          }
        }
      }
    }
    var tagCounts = new Map();
    var termCounts = new Map();
    countPairs(tagPostings, tagCounts);
    if (!budgetHit) countPairs(termPostings, termCounts);

    if (skippedCommon > 0) {
      complete = false;
      notes.push("Tags or title words used by more than " + T.MAX_POSTING_LIST + " listings were not used to look for similar pairs, so not every pair of listings could be compared.");
    }
    if (budgetHit) {
      complete = false;
      notes.push("This shop is large, so the comparison between listings stopped early and not all listing pairs were checked. Every per-listing check was still completed.");
    }

    // Identical-title groups: small groups become pairs, big ones one group.
    var bigGroups = [];
    var inBigGroup = Object.create(null);
    Object.keys(titleGroups).sort().forEach(function (k) {
      var g = titleGroups[k];
      if (g.length > T.BIG_TITLE_GROUP) {
        bigGroups.push(g);
        g.forEach(function (i) { inBigGroup[i] = k; });
      }
    });

    // ----- candidate pairs -----
    var pairs = new Map(); // pairKey -> {a, b, signals: {...}}
    function pairFor(a, b) {
      var lo = Math.min(a, b), hi = Math.max(a, b);
      if (inBigGroup[lo] !== undefined && inBigGroup[lo] === inBigGroup[hi]) return null;
      var pk = pairKeyOf(lo, hi, n);
      var p = pairs.get(pk);
      if (!p) { p = { a: lo, b: hi, pk: pk, sig: {} }; pairs.set(pk, p); }
      return p;
    }

    Object.keys(titleGroups).sort().forEach(function (k) {
      var g = titleGroups[k];
      if (g.length < 2 || g.length > T.BIG_TITLE_GROUP) return;
      for (var x = 0; x < g.length; x++) for (var y = x + 1; y < g.length; y++) {
        var p = pairFor(g[x], g[y]); if (p) p.sig.exactTitle = true;
      }
    });

    tagCounts.forEach(function (count, pk) {
      var a = Math.floor(pk / n), b = pk % n;
      var smaller = Math.min(listings[a].tagKeys.length, listings[b].tagKeys.length);
      var need = Math.max(T.TAG_OVERLAP_MIN_SHARED, Math.ceil(smaller * T.TAG_OVERLAP_MIN_RATIO));
      if (count >= need) {
        var p = pairFor(a, b); if (p) p.sig.tagOverlap = true;
      }
    });

    termCounts.forEach(function (count, pk) {
      var a = Math.floor(pk / n), b = pk % n;
      var smaller = Math.min(listings[a].terms.length, listings[b].terms.length);
      if (smaller < T.TITLE_SIMILAR_MIN_TERMS) return;
      if (count >= T.TITLE_SIMILAR_MIN_SHARED && count / smaller >= T.TITLE_SIMILAR_MIN_RATIO) {
        var p = pairFor(a, b); if (p) p.sig.similarTitle = true;
      }
    });

    // Identical descriptions: only with additional duplicate-listing evidence.
    var descGroupsTruncated = false;
    Object.keys(descGroups).sort().forEach(function (k) {
      var g = descGroups[k];
      if (g.length < 2) return;
      if (g.length > T.MAX_GROUP_PAIR_MEMBERS) { g = g.slice(0, T.MAX_GROUP_PAIR_MEMBERS); descGroupsTruncated = true; }
      for (var x = 0; x < g.length; x++) for (var y = x + 1; y < g.length; y++) {
        var a = g[x], b = g[y];
        var pk = pairKeyOf(a, b, n);
        var existing = pairs.get(pk);
        var tagShared = tagCounts.get(pk) || 0;
        var termShared = termCounts.get(pk) || 0;
        var supported = (existing && (existing.sig.exactTitle || existing.sig.similarTitle || existing.sig.tagOverlap)) ||
          tagShared >= T.DESC_SUPPORT_MIN_SHARED || termShared >= T.DESC_SUPPORT_MIN_SHARED ||
          (listings[a].titleKey && listings[a].titleKey === listings[b].titleKey);
        if (!supported) continue;
        var p = pairFor(a, b); if (p) p.sig.sameDescription = true;
      }
    });
    if (descGroupsTruncated) {
      complete = false;
      notes.push("A very large group of identical descriptions was only partly compared.");
    }

    // ----- build merged findings -----
    var findings = [];
    pairs.forEach(function (p) {
      var A = listings[p.a], B = listings[p.b];
      var signals = [];
      var strength = 0;

      if (p.sig.exactTitle) {
        signals.push({
          kind: "duplicate_title", heading: "Identical title",
          evidence: ["Both titles read “" + shorten(A.title, 120) + "” (ignoring capitalization, punctuation and spacing)."]
        });
        strength += 100;
      }
      if (p.sig.similarTitle && !p.sig.exactTitle) {
        var bTerms = new Set(B.terms);
        var shared = A.terms.filter(function (w) { return bTerms.has(w); });
        signals.push({
          kind: "similar_titles", heading: "Very similar titles",
          evidence: [shared.length + " shared meaningful words: " + shared.join(", ") + "."]
        });
        strength += 40 + shared.length;
      }
      if (p.sig.tagOverlap) {
        var bKeys = new Set(B.tagKeys);
        var sharedTags = A.tagKeys.filter(function (k) { return bKeys.has(k); });
        var shown = sharedTags.map(function (k) {
          for (var i = 0; i < A.tags.length; i++) if (A.tags[i].key === k) return A.tags[i].text;
          return k;
        });
        var smallerSet = Math.min(A.tagKeys.length, B.tagKeys.length);
        signals.push({
          kind: "tag_overlap", heading: "High tag overlap",
          evidence: [sharedTags.length + " of " + smallerSet + " tags (in the listing with fewer tags) are shared: " +
            shown.map(function (t) { return "“" + t + "”"; }).join(", ") + "."]
        });
        strength += 30 + sharedTags.length;
      }
      if (p.sig.sameDescription) {
        signals.push({
          kind: "same_description", heading: "Identical description text",
          evidence: ["The descriptions are identical (ignoring capitalization, punctuation and spacing), alongside the other overlap above."]
        });
        strength += 10;
      }
      if (!signals.length) return;
      findings.push({
        listings: [
          { row: A.row, label: A.label, title: A.title, sku: A.sku },
          { row: B.row, label: B.label, title: B.title, sku: B.sku }
        ],
        signals: signals,
        explanation: "These two listings overlap in the ways shown. That can be perfectly intentional (for example, variations of one product); it is worth reviewing only if they are meant to attract different buyers.",
        action: "Check whether each listing's title and tags make clear what is different about that product. If they are intentional variants, no change is needed.",
        strength: strength,
        order: p.a * n + p.b
      });
    });
    findings.sort(function (x, y) { return (y.strength - x.strength) || (x.order - y.order); });
    findings.forEach(function (f) { delete f.order; });

    var groupFindings = bigGroups.map(function (g) {
      var first = listings[g[0]];
      return {
        title: first.title,
        count: g.length,
        listings: g.slice(0, 10).map(function (i) { return { row: listings[i].row, label: listings[i].label }; }),
        moreCount: Math.max(0, g.length - 10),
        evidence: [g.length + " listings share the title “" + shorten(first.title, 120) + "” (ignoring capitalization, punctuation and spacing)."],
        action: "Check whether these listings need distinct titles so each product is clearly described."
      };
    });

    return { pairFindings: findings, groupFindings: groupFindings, complete: complete, notes: notes };
  }

  /* ------------------------------------------------------------
     Public: audit a CSV text
     ------------------------------------------------------------ */
  function fail(code, message) {
    return { ok: false, error: { code: code, message: message } };
  }

  function auditShopCsv(text, options) {
    options = options || {};
    var T = THRESHOLDS;
    if (typeof text !== "string") return fail("invalid", "The file could not be read as text.");
    var size = typeof options.sizeBytes === "number" ? options.sizeBytes : text.length;
    if (size > T.MAX_FILE_BYTES) {
      return fail("too_large", "This file is larger than " + (T.MAX_FILE_BYTES / (1024 * 1024)) + " MB, which is more than this audit can safely process in your browser. Export a smaller CSV and try again.");
    }
    if (!text.trim()) return fail("empty", "The file is empty. Choose the CSV you downloaded from Etsy.");
    if (text.indexOf("\u0000") !== -1) return fail("not_csv", "This doesn’t look like a text CSV file. Choose the CSV you downloaded from Etsy.");

    var parsed = parseCsv(text);
    if (!parsed.rows.length) return fail("empty", "The file is empty. Choose the CSV you downloaded from Etsy.");
    var header = parsed.rows[0];
    var cols = findColumns(header);

    var missing = [];
    if (cols.title < 0) missing.push("Title");
    if (cols.tags < 0) missing.push("Tags");
    if (missing.length) {
      var hint = "";
      if (header.length === 1 && /[;\t]/.test(header[0])) hint = " The file seems to use semicolons or tabs instead of commas; Etsy’s export is comma-separated.";
      return fail("missing_columns", "This CSV is missing the required " + missing.map(function (m) { return "“" + m + "”"; }).join(" and ") + " column" + (missing.length > 1 ? "s" : "") + ". Use the active-listings CSV from Shop Manager → Settings → Options → Download Data." + hint);
    }
    if (parsed.unterminatedQuote) {
      return fail("malformed", "The CSV looks damaged: a quoted cell was never closed. Re-download the file from Etsy and try again.");
    }

    var descPresent = cols.description >= 0;
    var listings = [];
    var blankRows = parsed.blankLines;
    for (var r = 1; r < parsed.rows.length; r++) {
      var cells = parsed.rows[r];
      var anyContent = cells.some(function (c) { return c !== ""; });
      if (!anyContent) { blankRows++; continue; }
      var get = function (idx) { return idx >= 0 && idx < cells.length ? cells[idx] : ""; };
      listings.push({
        row: parsed.rowNumbers[r],
        title: collapseSpaces(get(cols.title)),
        description: descPresent ? get(cols.description) : "",
        sku: collapseSpaces(get(cols.sku)),
        tags: parseTags(get(cols.tags))
      });
    }
    if (!listings.length) {
      return fail("no_rows", "No listing rows were found below the header row.");
    }

    // Labels: title (+ SKU); CSV row number when the title is blank or shared.
    var titleCounts = Object.create(null);
    listings.forEach(function (l) {
      var k = textKey(l.title);
      titleCounts[k] = (titleCounts[k] || 0) + 1;
    });
    listings.forEach(function (l) {
      var k = textKey(l.title);
      var label = l.title ? shorten(l.title, 90) : "(no title)";
      if (l.sku) label += " · SKU " + shorten(l.sku, 40);
      if (!l.title || titleCounts[k] > 1) label += " · CSV row " + l.row;
      l.label = label;
    });

    var listingFindings = [];
    listings.forEach(function (l) {
      var f = listingChecks(l, descPresent);
      if (f.length) listingFindings.push({ row: l.row, label: l.label, title: l.title, sku: l.sku, findings: f });
    });
    var rank = function (g) {
      var issues = g.findings.filter(function (x) { return x.severity === "issue"; }).length;
      return { hasIssue: issues > 0 ? 1 : 0, issues: issues };
    };
    listingFindings.sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      return (rb.hasIssue - ra.hasIssue) || (rb.issues - ra.issues) || (a.row - b.row);
    });
    var structural = listingFindings.filter(function (g) { return rank(g).hasIssue; }).length;

    var cross = crossChecks(listings, descPresent);
    var pairsTotal = cross.pairFindings.length;
    var pairsKept = cross.pairFindings.slice(0, T.MAX_STORED_PAIRS);

    var notes = [];
    if (!descPresent) notes.push("This CSV has no Description column, so description checks were skipped. Title and tag checks were still run.");
    if (blankRows > 0) notes.push(blankRows + " blank row" + (blankRows === 1 ? " was" : "s were") + " ignored.");
    cross.notes.forEach(function (x) { notes.push(x); });
    if (pairsTotal > pairsKept.length) notes.push("Showing the strongest " + pairsKept.length + " of " + pairsTotal + " listing pairs.");

    return {
      ok: true,
      columns: cols,
      descriptionChecked: descPresent,
      summary: {
        listingsAnalyzed: listings.length,
        listingsWithFindings: listingFindings.length,
        listingsWithStructuralIssues: structural,
        pairsToReview: pairsTotal,
        duplicateTitleGroups: cross.groupFindings.length,
        blankRowsIgnored: blankRows
      },
      listingFindings: listingFindings,
      pairFindings: pairsKept,
      groupFindings: cross.groupFindings,
      pairCheckComplete: cross.complete,
      notes: notes,
      noIssues: listingFindings.length === 0 && pairsTotal === 0 && cross.groupFindings.length === 0,
      emptyStateMessage: "No issues were detected by these checks.",
      emptyStateCaveat: "This is not an Etsy ranking or performance audit, and it does not guarantee that your listings are optimized.",
      thresholds: THRESHOLDS
    };
  }

  return {
    THRESHOLDS: THRESHOLDS,
    MAX_FILE_BYTES: THRESHOLDS.MAX_FILE_BYTES,
    parseCsv: parseCsv,
    parseTags: parseTags,
    normalizeHeader: normalizeHeader,
    findColumns: findColumns,
    tagKey: tagKey,
    textKey: textKey,
    meaningfulTerms: meaningfulTerms,
    auditShopCsv: auditShopCsv
  };
});
