"use strict";
// Run with:  node --test tests/shop-health-audit.test.cjs
// Pure-logic tests for public/shop-health-audit.js (Node built-ins only).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MODULE_PATH = path.join(__dirname, "..", "public", "shop-health-audit.js");
const A = require(MODULE_PATH);
const T = A.THRESHOLDS;

/* ---------- helpers ---------- */
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
function csv(headers, rows, eol) {
  return [headers.join(",")].concat(rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? q(c) : c)).join(","))).join(eol || "\r\n") + (eol || "\r\n");
}
const H = ["TITLE", "DESCRIPTION", "PRICE", "CURRENCY_CODE", "QUANTITY", "TAGS", "MATERIALS", "IMAGE1", "SKU"];
function row(o) {
  o = o || {};
  return [o.title == null ? "Oak Cutting Board" : o.title, o.description == null ? "A board." : o.description, "25.00", "USD", "3",
    o.tags == null ? THIRTEEN.join(",") : o.tags, o.materials || "oak", "https://img.example/1.jpg", o.sku || ""];
}
const THIRTEEN = ["cutting board", "oak board", "kitchen gift", "wood serving tray", "housewarming idea", "charcuterie board", "chopping block",
  "farmhouse kitchen", "wedding present", "hostess gift", "butcher block", "rustic decor", "cheese platter"];
const audit = (text, opts) => A.auditShopCsv(text, opts);
const kinds = (g) => g.findings.map((f) => f.kind);
const findingsFor = (res, rowNo) => (res.listingFindings.find((g) => g.row === rowNo) || { findings: [] }).findings;

/* 1. normal Etsy-like CSV */
test("1. normal Etsy-like CSV with standard headers is analyzed", () => {
  const res = audit(csv(H, [row({ title: "Oak Cutting Board", sku: "OAK-1" }), row({ title: "Maple Spoon Set", tags: "wood spoon,kitchen utensil,cooking gift,spoon set,baking tools,maple spoon,serving spoons,handmade spoons,gift for cook,kitchen decor,wooden spatula,chef gift,home cooking", description: "Spoons made from maple." })]));
  assert.equal(res.ok, true);
  assert.equal(res.summary.listingsAnalyzed, 2);
  assert.equal(res.summary.listingsWithFindings, 0);
  assert.equal(res.summary.pairsToReview, 0);
  assert.equal(res.descriptionChecked, true);
  assert.equal(res.noIssues, true);
  assert.equal(res.listingFindings.length, 0);
});

/* 2. BOM + header variations */
test("2. UTF-8 BOM and header spacing/case/punctuation variations", () => {
  const text = "﻿  title , Description ,TAGS,sku numbers,Materials\nNice Mug,Good mug,\"mug a,mug b\",SKU-9,clay\n";
  const res = audit(text);
  assert.equal(res.ok, true);
  assert.equal(res.summary.listingsAnalyzed, 1);
  assert.equal(res.columns.sku, 3);
  assert.equal(res.columns.materials, 4);
  assert.match(res.listingFindings[0].label, /Nice Mug · SKU SKU-9/);
  assert.equal(A.normalizeHeader("SKU_Number(s)"), "skunumbers");
  assert.equal(A.normalizeHeader("﻿Title"), "title");
  assert.equal(A.findColumns(["Sku"]).sku, 0);
  assert.equal(A.findColumns(["SKUs"]).sku, 0);
  assert.equal(A.findColumns(["Random Column"]).title, -1, "arbitrary columns are never guessed");
});

/* 3. quoted commas and line breaks in Description */
test("3. quoted commas and line breaks in Description do not break rows", () => {
  const desc = "Line one, with comma\nLine two\r\nLine three";
  const text = csv(H, [row({ title: "Board A", description: desc }), row({ title: "Board B", tags: "one tag" })]);
  const parsed = A.parseCsv(text);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[1][1], desc);
  assert.deepEqual(parsed.rowNumbers, [1, 2, 3]);
  const res = audit(text);
  assert.equal(res.summary.listingsAnalyzed, 2);
});

/* 4. escaped quotes */
test("4. escaped double quotes inside cells", () => {
  const parsed = A.parseCsv('Title,Tags\n"The ""Best"" Mug","mug ""x"",other"\n');
  assert.equal(parsed.rows[1][0], 'The "Best" Mug');
  assert.deepEqual(A.parseTags(parsed.rows[1][1]).map((t) => t.text), ['mug "x"', "other"]);
});

/* 5. missing required headers */
test("5. missing Title or Tags headers produce a clear error naming the column", () => {
  let res = audit("Description,Tags\nx,y\n");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "missing_columns");
  assert.match(res.error.message, /“Title”/);
  assert.doesNotMatch(res.error.message, /“Tags”/);
  res = audit("Title,Description\nx,y\n");
  assert.match(res.error.message, /“Tags”/);
  res = audit("Name,Words\nx,y\n");
  assert.match(res.error.message, /“Title” and “Tags” columns/);
  res = audit("Title;Tags;Description\nx;y;z\n");
  assert.equal(res.ok, false);
  assert.match(res.error.message, /semicolons or tabs/);
});

/* 6. blank rows */
test("6. blank lines and all-empty rows are ignored and disclosed", () => {
  const text = "TITLE,TAGS\n\nBoard,\"a b,c d\"\n,\n   \nSpoon,\"x y\"\n\n";
  const res = audit(text);
  assert.equal(res.ok, true);
  assert.equal(res.summary.listingsAnalyzed, 2);
  assert.ok(res.summary.blankRowsIgnored >= 3);
  assert.ok(res.notes.some((n) => /blank row/.test(n)));
  // row numbers still match what a spreadsheet shows
  assert.deepEqual(res.listingFindings.map((g) => g.row).sort((a, b) => a - b), [3, 6]);
});

/* 7. title length */
test("7. titles over 140 characters report the real count and limit; exactly 140 passes", () => {
  const long = "A".repeat(152);
  const res = audit(csv(H, [row({ title: long }), row({ title: "B".repeat(140), tags: THIRTEEN.join(",") })]));
  const f = findingsFor(res, 2);
  assert.deepEqual(kinds({ findings: f }), ["title_too_long"]);
  assert.match(f[0].evidence[0], /152 characters; the limit is 140/);
  assert.match(f[0].action, /at least 12 characters/);
  assert.equal(findingsFor(res, 3).length, 0);
  const emoji = "😀".repeat(141);
  assert.match(findingsFor(audit(csv(H, [row({ title: emoji })])), 2)[0].evidence[0], /141 characters/, "code points, not UTF-16 units");
});

/* 8. long and duplicate tags */
test("8. overlong tags and duplicate tags carry exact evidence", () => {
  const tags = "personalized wooden board,cutting board,Cutting  Board,oak board,exactly twenty chars";
  const res = audit(csv(H, [row({ tags })]));
  const f = findingsFor(res, 2);
  const long = f.find((x) => x.kind === "tag_too_long");
  assert.ok(long);
  assert.deepEqual(long.evidence, ["“personalized wooden board” is 25 characters (limit 20, spaces included)."]);
  const dup = f.find((x) => x.kind === "duplicate_tags");
  assert.ok(dup);
  assert.match(dup.evidence[0], /“cutting board” \/ “Cutting  Board” appears 2 times/);
  assert.equal(A.tagKey("Cutting  Board"), "cutting board");
  assert.ok(!f.some((x) => x.heading && /exactly twenty/.test(x.evidence.join(""))), "a 20-character tag is fine");
  assert.equal(A.parseTags("exactly twenty chars").length, 1);
  assert.equal([..."exactly twenty chars"].length, 20);
});

/* 9. fewer than 13 tags */
test("9. fewer than 13 tags is an opportunity, worded as unused slots, not a defect", () => {
  const res = audit(csv(H, [row({ tags: "cutting board,oak board,kitchen gift" })]));
  const f = findingsFor(res, 2);
  assert.deepEqual(kinds({ findings: f }), ["fewer_tags"]);
  assert.equal(f[0].severity, "opportunity");
  assert.equal(f[0].evidence[0], "Uses 3 of 13 available tag slots.");
  assert.match(f[0].action, /only tags that truly fit/);
  assert.doesNotMatch(JSON.stringify(f[0]), /violat|penal|rank(?!ing)|hurt|must/i);
  assert.equal(res.summary.listingsWithStructuralIssues, 0, "not counted as a structural issue");
  assert.equal(res.summary.listingsWithFindings, 1);
  const zero = findingsFor(audit(csv(H, [row({ tags: "" })])), 2);
  assert.equal(zero[0].evidence[0], "Uses 0 of 13 available tag slots.");
});

/* 10. high tag overlap */
test("10. high tag overlap names both listings and the exact shared tags", () => {
  const a = THIRTEEN.slice();
  const b = THIRTEEN.slice(0, 8).concat(["pizza peel", "bread board", "walnut tray", "gift for dad", "grill planks"]);
  const res = audit(csv(H, [row({ title: "Oak Cutting Board", tags: a.join(",") }), row({ title: "Walnut Serving Paddle", tags: b.join(",") })]));
  assert.equal(res.summary.pairsToReview, 1);
  const p = res.pairFindings[0];
  assert.deepEqual(p.listings.map((l) => l.title), ["Oak Cutting Board", "Walnut Serving Paddle"]);
  const sig = p.signals.find((s) => s.kind === "tag_overlap");
  assert.ok(sig);
  assert.match(sig.evidence[0], /^8 of 13 tags/);
  THIRTEEN.slice(0, 8).forEach((t) => assert.ok(sig.evidence[0].includes("“" + t + "”"), t));
  assert.match(p.explanation, /intentional/);
  assert.doesNotMatch(JSON.stringify(p), /hurt|penal|ranking|lower/i);
});

/* 11. exact duplicate titles */
test("11. exact duplicate titles (ignoring case, punctuation, spacing) are one merged pair finding", () => {
  const res = audit(csv(H, [row({ title: "Oak Cutting Board!", sku: "A" }), row({ title: "  oak   cutting board ", sku: "B" }), row({ title: "Different Spoon Holder Rack", tags: "spoon rest,kitchen tool" })]));
  assert.equal(res.summary.pairsToReview, 1);
  const p = res.pairFindings[0];
  assert.equal(p.signals[0].kind, "duplicate_title");
  assert.match(p.listings[0].label, /SKU A · CSV row 2/, "duplicate title -> row number disambiguator");
  assert.match(p.listings[1].label, /SKU B · CSV row 3/);
});

test("11b. blank titles get a row-number label and are reported per listing", () => {
  const res = audit(csv(H, [row({ title: "" })]));
  assert.equal(findingsFor(res, 2)[0].kind, "missing_title");
  assert.match(res.listingFindings[0].label, /\(no title\) · CSV row 2/);
});

test("11c. a large group of identical titles is one group finding, not a flood of pairs", () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row({ title: "Same Title Everywhere", tags: "tag " + i + " a,tag " + i + " b" }));
  const res = audit(csv(H, rows));
  assert.equal(res.summary.pairsToReview, 0);
  assert.equal(res.groupFindings.length, 1);
  assert.equal(res.groupFindings[0].count, 12);
  assert.equal(res.groupFindings[0].listings.length, 10);
  assert.equal(res.groupFindings[0].moreCount, 2);
});

/* 12. weak overlap */
test("12. weak overlap and common words do not produce actionable similarity warnings", () => {
  const rows = [
    row({ title: "Personalized Gift for Her Handmade Necklace", tags: "gift for her,custom necklace,birthday present" + ",a one,b two,c three,d four,e five,f six,g seven,h eight,i nine" }),
    row({ title: "Personalized Gift for Her Leather Wallet", tags: "gift for her,custom wallet,birthday present" + ",j one,k two,l three,m four,n five,o six,p seven,q eight,r nine" }),
    row({ title: "Custom Handmade Gift Candle Holder", tags: "gift for her,candle holder,s one,t two,u three,v four,w five,x six,y seven,z eight,aa nine,bb ten,cc eleven" })
  ];
  const res = audit(csv(H, rows));
  assert.equal(res.summary.pairsToReview, 0);
  assert.equal(res.pairFindings.length, 0);
  assert.equal(A.meaningfulTerms("Personalized Gift for Her Handmade Necklace").join(","), "necklace");
});

test("12b. similar titles need several meaningful shared words and show those words", () => {
  const rows = [
    row({ title: "Dog Mom Sweatshirt Funny Crewneck Pullover", tags: "a1 x,a2 x,a3 x" }),
    row({ title: "Dog Mom Sweatshirt Funny Crewneck Hoodie", tags: "b1 y,b2 y,b3 y" }),
    row({ title: "Dog Mom Sweatshirt Retro Tee", tags: "c1 z,c2 z,c3 z" })
  ];
  const res = audit(csv(H, rows));
  assert.equal(res.summary.pairsToReview, 1);
  const s = res.pairFindings[0].signals[0];
  assert.equal(s.kind, "similar_titles");
  assert.match(s.evidence[0], /5 shared meaningful words: dog, mom, sweatshirt, funny, crewneck\./);
  assert.doesNotMatch(JSON.stringify(res.pairFindings), /score|%/i);
});

/* 13. boilerplate descriptions */
test("13. identical boilerplate descriptions alone do not create warnings", () => {
  const boiler = "Thank you for visiting my shop! All items are handmade with care. Ships within 3 business days.";
  const res = audit(csv(H, [
    row({ title: "Oak Cutting Board Large", description: boiler, tags: THIRTEEN.join(",") }),
    row({ title: "Ceramic Planter Pot Blue", description: boiler, tags: "plant pot,ceramic pot,garden gift,indoor plant,blue planter,succulent pot,home decor,gift for mom,planter set,window planter,desk plant,flower pot,mini planter" })
  ]));
  assert.equal(res.summary.pairsToReview, 0);
  assert.equal(res.noIssues, true);
});

test("13b. identical descriptions ARE added as supporting evidence when the titles/tags already overlap", () => {
  const boiler = "Thank you for visiting my shop! All items are handmade with care. Ships within 3 business days.";
  const b = THIRTEEN.slice(0, 7).concat(["x1 a", "x2 a", "x3 a", "x4 a", "x5 a", "x6 a"]);
  const res = audit(csv(H, [row({ title: "Oak Cutting Board Large", description: boiler }), row({ title: "Walnut Serving Paddle Wide", description: boiler, tags: b.join(",") })]));
  assert.equal(res.summary.pairsToReview, 1);
  assert.deepEqual(res.pairFindings[0].signals.map((s) => s.kind), ["tag_overlap", "same_description"], "merged into one compact finding");
});

/* 14. XSS-looking strings */
test("14. XSS-looking strings stay inert data (returned verbatim, never interpreted)", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const res = audit(csv(H, [row({ title: evil + "A".repeat(150), tags: "<script>alert(1)</script> tag,\"" + evil + " tag\"", sku: "<b>sku</b>" })]));
  const g = res.listingFindings[0];
  assert.ok(g.label.includes("<img"), "kept as text");
  assert.equal(typeof g.label, "string");
  assert.ok(JSON.stringify(res).includes("<script>"));
  const src = fs.readFileSync(MODULE_PATH, "utf8");
  assert.doesNotMatch(src, /innerHTML|document\.write|insertAdjacentHTML|eval\(|new Function/);
});

/* 15. missing Description */
test("15. a CSV without Description still gets title/tag checks and a limitation note", () => {
  const res = audit("TITLE,TAGS\nBoard," + q("one tag,two tag") + "\n");
  assert.equal(res.ok, true);
  assert.equal(res.descriptionChecked, false);
  assert.ok(res.notes.some((n) => /no Description column, so description checks were skipped/.test(n)));
  assert.deepEqual(kinds(res.listingFindings[0]), ["fewer_tags"]);
  const withCol = audit(csv(H, [row({ description: "" })]));
  assert.ok(findingsFor(withCol, 2).some((f) => f.kind === "blank_description"));
});

/* 16. empty / invalid / oversized */
test("16. empty, invalid and oversized files fail safely", () => {
  for (const bad of ["", "   \n  ", "﻿"]) {
    const r = audit(bad);
    assert.equal(r.ok, false); assert.equal(r.error.code, "empty");
  }
  assert.equal(audit(null).ok, false);
  assert.equal(audit(undefined).ok, false);
  assert.equal(audit(12345).error.code, "invalid");
  assert.equal(audit("PK\u0003\u0004\u0000\u0000binary").error.code, "not_csv");
  assert.equal(audit("TITLE,TAGS\n").error.code, "no_rows");
  assert.equal(audit('TITLE,TAGS\n"unclosed,tag').error.code, "malformed");
  const big = audit("TITLE,TAGS\nx,y\n", { sizeBytes: T.MAX_FILE_BYTES + 1 });
  assert.equal(big.ok, false); assert.equal(big.error.code, "too_large");
  assert.match(big.error.message, /10 MB/);
  assert.equal(audit("x".repeat(T.MAX_FILE_BYTES + 1)).error.code, "too_large");
  assert.equal(audit("TITLE,TAGS\nx,y\n", { sizeBytes: T.MAX_FILE_BYTES }).ok, true);
});

/* 17. truthful empty state */
test("17. no findings -> truthful empty state, nothing invented", () => {
  const res = audit(csv(H, [row({ title: "Oak Cutting Board" }), row({ title: "Stainless Water Bottle Insulated", tags: "water bottle,steel bottle,gym gift,hiking gear,insulated cup,camping flask,sports bottle,travel mug,gift for him,eco friendly,reusable bottle,cold drink,hot drink" })]));
  assert.equal(res.noIssues, true);
  assert.equal(res.emptyStateMessage, "No issues were detected by these checks.");
  assert.match(res.emptyStateCaveat, /not an Etsy ranking or performance audit/);
  assert.match(res.emptyStateCaveat, /does not guarantee/);
  assert.equal(res.listingFindings.length + res.pairFindings.length + res.groupFindings.length, 0);
});

/* ---------- extra guarantees ---------- */
test("no score, no invented Etsy metrics in any output", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(row({ title: "Dog Mom Sweatshirt Funny Crewneck Style " + i, tags: THIRTEEN.slice(0, 9).join(",") + ",tag " + i + " a,tag " + i + " b,tag " + i + " c,tag " + i + " d", description: "Thank you for visiting my shop and reading this long identical text." }));
  const res = audit(csv(H, rows.concat([row({ title: "X".repeat(150), tags: "short,personalized wooden cutting board" })])));
  const text = JSON.stringify(res);
  assert.doesNotMatch(text, /"score"|health score|seo score|search volume|conversion|impressions|visits|sales/i);
  assert.ok(!("score" in res.summary));
});

test("thresholds are fixed and deterministic", () => {
  assert.equal(T.TITLE_MAX_CHARS, 140);
  assert.equal(T.TAG_MAX_CHARS, 20);
  assert.equal(T.TAG_SLOTS, 13);
  assert.equal(T.TITLE_SIMILAR_MIN_SHARED, 4);
  assert.equal(T.TITLE_SIMILAR_MIN_RATIO, 0.75);
  assert.equal(T.TAG_OVERLAP_MIN_SHARED, 4);
  assert.equal(T.TAG_OVERLAP_MIN_RATIO, 0.5);
  assert.equal(T.MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.throws(() => { "use strict"; T.TITLE_MAX_CHARS = 1; });
  const input = csv(H, [row({ title: "A Board" }), row({ title: "A Board" })]);
  assert.deepEqual(audit(input), audit(input), "same input -> identical output");
});

test("tag overlap boundary: 3 shared tags never flags; 7 of 13 does not, 7 of 13 shared>=50% does", () => {
  const base = THIRTEEN;
  const mk = (n) => base.slice(0, n).concat(Array.from({ length: 13 - n }, (_, i) => "uniq" + n + " t" + i));
  const mkB = (n) => base.slice(0, n).concat(Array.from({ length: 13 - n }, (_, i) => "other" + n + " u" + i));
  const run = (n) => audit(csv(H, [row({ title: "Alpha Board Item", tags: mk(n).join(",") }), row({ title: "Zeta Spoon Piece", tags: mkB(n).join(",") })])).summary.pairsToReview;
  assert.equal(run(3), 0);
  assert.equal(run(6), 0, "6 of 13 is below 50% of the smaller set (needs 7)");
  assert.equal(run(7), 1);
});

test("the module makes no network or storage calls", () => {
  const src = fs.readFileSync(MODULE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of ["fetch(", "XMLHttpRequest", "FormData", "localStorage", "sessionStorage", "supabase", "Supabase", "groq", "Groq", "navigator.sendBeacon", "WebSocket", "indexedDB", "document."]) {
    assert.ok(!src.includes(bad), "must not contain " + bad);
  }
});

test("large shops stay bounded: 3000 listings with a very common tag finish quickly and disclose the limit", () => {
  const rows = [];
  for (let i = 0; i < 3000; i++) rows.push(["Item number " + i + " unique" + i, "desc " + i, "1", "USD", "1", "handmade gift,shared tag " + (i % 7) + ",own tag " + i + " x", "", "", ""]);
  const text = csv(H, rows);
  const t0 = Date.now();
  const res = audit(text);
  const ms = Date.now() - t0;
  assert.equal(res.ok, true);
  assert.equal(res.summary.listingsAnalyzed, 3000);
  assert.equal(res.pairCheckComplete, false);
  assert.ok(res.notes.some((n) => /not every pair of listings could be compared|not all listing pairs/.test(n)));
  assert.ok(ms < 8000, "took " + ms + "ms");
  assert.equal(res.listingFindings.length, 3000, "all per-listing checks still ran");
});

test("many pairs are capped in storage but the true count is kept and disclosed", () => {
  const rows = [];
  for (let g = 0; g < 600; g++) {
    const shared = Array.from({ length: 13 }, (_, i) => "grp" + g + " tag" + i);
    rows.push(row({ title: "Alpha" + g + " product", tags: shared.join(",") }));
    rows.push(row({ title: "Beta" + g + " thing", tags: shared.join(",") }));
  }
  const res = audit(csv(H, rows));
  assert.equal(res.summary.pairsToReview, 600);
  assert.equal(res.pairFindings.length, T.MAX_STORED_PAIRS);
  assert.ok(res.notes.some((n) => /strongest 500 of 600/.test(n)));
});

test("tags used by more than 80 listings are not used for pair finding, and this is disclosed", () => {
  const rows = [];
  const common = ["common one", "common two", "common three", "common four", "common five"];
  for (let i = 0; i < 100; i++) rows.push(row({ title: "Distinct" + i + " widget" + i, tags: common.join(",") }));
  const res = audit(csv(H, rows));
  assert.equal(res.summary.listingsAnalyzed, 100);
  assert.equal(res.summary.pairsToReview, 0, "no 4,950-pair flood");
  assert.equal(res.pairCheckComplete, false);
  assert.ok(res.notes.some((n) => /more than 80 listings/.test(n)));
  assert.equal(res.listingFindings.length, 100, "per-listing checks (open tag slots) all ran");
});
