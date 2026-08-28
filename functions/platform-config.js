/**
 * =============================================================
 * TagPulse AI — Platform Configuration
 *
 * Shared platform definitions used by:
 *   - generate.js
 *   - output-validator.js
 *   - future dynamic frontend rendering
 *
 * IMPORTANT:
 *   This file contains configuration only.
 *   It does NOT handle:
 *   - authentication
 *   - credits
 *   - payments
 *   - database access
 *   - Groq requests
 *
 * Existing platform IDs are preserved:
 *   etsy
 *   digital-printable
 *   print-on-demand
 *   pinterest
 * =============================================================
 */


/**
 * =============================================================
 * PLATFORM CONFIG
 * =============================================================
 */

export const PLATFORM_CONFIG = {


  /**
   * ===========================================================
   * EXISTING PLATFORMS
   * ===========================================================
   */

  etsy: {
    id: "etsy",
    name: "Etsy",
    group: "Marketplace",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: 140
      },

      tags: {
        required: true,
        count: 13,
        perTagMaxCharacters: 20
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate exactly 13 Etsy tags.",
      "Each Etsy tag must be 20 characters or fewer.",
      "Use specific, relevant search phrases.",
      "Do not use duplicate or near-duplicate tags.",
      "Keep the title readable and keyword-rich.",
      "Do not use misleading or unrelated keywords."
    ]
  },


  "digital-printable": {
    id: "digital-printable",
    name: "Digital / Printable",
    group: "Digital Products",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: 140
      },

      tags: {
        required: true,
        count: 13,
        perTagMaxCharacters: 20
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate exactly 13 relevant SEO tags.",
      "Keep every tag concise and search-focused.",
      "Do not use duplicate or near-duplicate tags.",
      "Prioritize buyer intent and product-specific phrases."
    ]
  },


  "print-on-demand": {
    id: "print-on-demand",
    name: "Print on Demand",
    group: "POD",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: 140
      },

      tags: {
        required: true,
        count: 13,
        perTagMaxCharacters: 20
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate exactly 13 relevant SEO tags.",
      "Focus on design subject, niche, style, audience and use case.",
      "Avoid irrelevant trend stuffing or trademark misuse."
    ]
  },


  pinterest: {
    id: "pinterest",
    name: "Pinterest",
    group: "Social Discovery",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: 140
      },

      tags: {
        required: true,
        count: 13,
        perTagMaxCharacters: 50
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate exactly 13 relevant Pinterest search keywords or tags.",
      "Prioritize discoverability and natural search language.",
      "Avoid keyword stuffing.",
      "Write the description for Pinterest discovery and click intent."
    ]
  },


  /**
   * ===========================================================
   * AMAZON ECOSYSTEM
   * ===========================================================
   */

  "amazon-merch": {
    id: "amazon-merch",
    name: "Amazon Merch on Demand",
    group: "Amazon",

    output: {
      fields: [
        "title",
        "brand_name",
        "bullet_points",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      brandName: {
        required: true
      },

      bulletPoints: {
        required: true,
        count: 2
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate an Amazon Merch on Demand listing.",
      "Return a clear product title.",
      "Generate a brand name appropriate to the design.",
      "Generate exactly 2 concise product bullet points.",
      "Generate a useful product description.",
      "Avoid misleading claims.",
      "Avoid unauthorized trademarks, copyrighted brands and unrelated keywords."
    ]
  },


  "amazon-kdp": {
    id: "amazon-kdp",
    name: "Amazon KDP",
    group: "Amazon",

    output: {
      fields: [
        "title",
        "backend_keywords",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      backendKeywords: {
        required: true,
        count: 7,
        maxEntries: 7
      },

      description: {
        required: true,
        formatting: "kdp"
      }
    },

    promptRules: [
      "Generate up to exactly 7 relevant KDP keyword entries.",
      "Each keyword should accurately describe the book.",
      "Use specific reader-oriented search phrases.",
      "Do not use misleading metadata.",
      "Do not use other authors' names or unrelated brands.",
      "Do not use promotional claims such as best-selling or free.",
      "Do not place HTML tags inside keyword fields."
    ]
  },


  "amazon-handmade": {
    id: "amazon-handmade",
    name: "Amazon Handmade",
    group: "Amazon",

    output: {
      fields: [
        "title",
        "description",
        "backend_keywords"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      backendKeywords: {
        required: true,
        count: 7
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate a clear Amazon Handmade listing title.",
      "Generate exactly 7 relevant backend keyword phrases.",
      "Focus keywords on material, product type, style, occasion and buyer intent.",
      "Write a useful, accurate product description.",
      "Avoid keyword stuffing and unrelated terms."
    ]
  },


  /**
   * ===========================================================
   * DIGITAL PRODUCT MARKETPLACES
   * ===========================================================
   */

  gumroad: {
    id: "gumroad",
    name: "Gumroad",
    group: "Digital Products",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        count: 10
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate concise SEO-oriented product metadata.",
      "Focus on product intent and buyer language.",
      "Keep tags relevant to the actual product.",
      "Avoid keyword stuffing."
    ]
  },


  payhip: {
    id: "payhip",
    name: "Payhip",
    group: "Digital Products",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        count: 10
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate relevant product-search tags.",
      "Write a clear conversion-focused description.",
      "Prioritize specific buyer intent."
    ]
  },


  "lemon-squeezy": {
    id: "lemon-squeezy",
    name: "Lemon Squeezy",
    group: "Digital Products",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        count: 10
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate SEO-friendly digital-product metadata.",
      "Focus on product benefits, use cases and buyer intent.",
      "Keep tags specific and relevant."
    ]
  },


  "teachers-pay-teachers": {
    id: "teachers-pay-teachers",
    name: "Teachers Pay Teachers",
    group: "Digital Products",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        count: 10
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate education-specific SEO metadata.",
      "Target teachers searching for the resource.",
      "Use grade level, subject, resource type, skills and classroom intent when relevant.",
      "Avoid irrelevant keyword stuffing."
    ]
  },


  "creative-market": {
    id: "creative-market",
    name: "Creative Market",
    group: "Design Marketplaces",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        count: 15
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate design-marketplace SEO metadata.",
      "Focus on design category, style, format, use case and audience.",
      "Use accurate design terminology."
    ]
  },


  "design-bundles": {
    id: "design-bundles",
    name: "Design Bundles",
    group: "Design Marketplaces",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        count: 15
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate design-resource SEO metadata.",
      "Focus on resource type, style, theme, format and intended use.",
      "Keep tags accurate and specific."
    ]
  },


  /**
   * ===========================================================
   * ALTERNATIVE POD PLATFORMS
   * ===========================================================
   */

  redbubble: {
    id: "redbubble",
    name: "Redbubble",
    group: "POD",

    output: {
      fields: [
        "title",
        "tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      tags: {
        required: true,
        maxEntries: 15,
        recommendedMin: 10,
        recommendedMax: 15,
        perTagMaxCharacters: 50
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate up to 15 highly relevant Redbubble tags.",
      "Use between 10 and 15 tags when enough relevant terms exist.",
      "Each tag must be 50 characters or fewer.",
      "Tags must accurately describe the artwork.",
      "Do not use tag spam.",
      "Do not use unrelated trending terms.",
      "Avoid unauthorized trademark terms."
    ]
  },


  teepublic: {
    id: "teepublic",
    name: "TeePublic",
    group: "POD",

    output: {
      fields: [
        "title",
        "main_tag",
        "secondary_tags",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      mainTag: {
        required: true
      },

      secondaryTags: {
        required: true,
        count: 10
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate one primary/main tag.",
      "Generate relevant secondary tags.",
      "Keep all tags directly relevant to the design.",
      "Avoid keyword stuffing and trademark misuse."
    ]
  },


  zazzle: {
    id: "zazzle",
    name: "Zazzle",
    group: "POD",

    output: {
      fields: [
        "title",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate a clear product title.",
      "Write an engaging product story focused on the design and buyer use case.",
      "Use natural, relevant search language."
    ]
  },


  society6: {
    id: "society6",
    name: "Society6",
    group: "POD",

    output: {
      fields: [
        "title",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: null
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate a descriptive design title.",
      "Write a natural product storytelling description.",
      "Focus on visual style, theme and buyer appeal."
    ]
  },


  /**
   * ===========================================================
   * INDEPENDENT E-COMMERCE
   * ===========================================================
   */

  shopify: {
    id: "shopify",
    name: "Shopify",
    group: "E-commerce",

    output: {
      fields: [
        "product_title",
        "meta_title",
        "meta_description",
        "product_copy"
      ],

      productTitle: {
        required: true,
        maxCharacters: null
      },

      metaTitle: {
        required: true,
        maxCharacters: 60
      },

      metaDescription: {
        required: true,
        maxCharacters: 160
      },

      productCopy: {
        required: true
      }
    },

    promptRules: [
      "Write product copy for an independent Shopify store.",
      "Generate a concise Google-oriented meta title.",
      "Generate a concise Google-oriented meta description.",
      "Avoid keyword stuffing.",
      "Prioritize search intent and conversion."
    ]
  },


  woocommerce: {
    id: "woocommerce",
    name: "WooCommerce",
    group: "E-commerce",

    output: {
      fields: [
        "product_title",
        "meta_title",
        "meta_description",
        "product_copy"
      ],

      productTitle: {
        required: true,
        maxCharacters: null
      },

      metaTitle: {
        required: true,
        maxCharacters: 60
      },

      metaDescription: {
        required: true,
        maxCharacters: 160
      },

      productCopy: {
        required: true
      }
    },

    promptRules: [
      "Write SEO-focused WooCommerce product copy.",
      "Generate a concise meta title.",
      "Generate a concise meta description.",
      "Focus on search intent, product relevance and conversion."
    ]
  },


  /**
   * ===========================================================
   * RESELLING APPS
   * ===========================================================
   */

  ebay: {
    id: "ebay",
    name: "eBay",
    group: "Reselling",

    output: {
      fields: [
        "title",
        "item_specific_keywords",
        "description"
      ],

      title: {
        required: true,
        maxCharacters: 80
      },

      itemSpecificKeywords: {
        required: true,
        count: 10
      },

      description: {
        required: true
      }
    },

    promptRules: [
      "Generate an eBay listing title of 80 characters or fewer.",
      "Use the available title length efficiently.",
      "Include important product identifying attributes when known.",
      "Generate relevant item-specific keywords.",
      "Avoid unnecessary punctuation and irrelevant words.",
      "Never exceed 80 characters."
    ]
  },


  poshmark: {
    id: "poshmark",
    name: "Poshmark",
    group: "Reselling",

    output: {
      fields: [
        "title",
        "description",
        "hashtags"
      ],

      title: {
        required: true,
        maxCharacters: 80
      },

      description: {
        required: true
      },

      hashtags: {
        required: true,
        minEntries: 3,
        maxEntries: 5
      }
    },

    promptRules: [
      "Write a concise reselling listing title.",
      "Write a buyer-focused description.",
      "Generate exactly 3 to 5 relevant hashtags.",
      "Prioritize product type, brand, style, condition and use case."
    ]
  },


  mercari: {
    id: "mercari",
    name: "Mercari",
    group: "Reselling",

    output: {
      fields: [
        "title",
        "description",
        "hashtags"
      ],

      title: {
        required: true,
        maxCharacters: 80
      },

      description: {
        required: true
      },

      hashtags: {
        required: true,
        minEntries: 3,
        maxEntries: 5
      }
    },

    promptRules: [
      "Write a concise marketplace listing title.",
      "Write an informative product description.",
      "Generate exactly 3 to 5 relevant hashtags.",
      "Avoid keyword stuffing."
    ]
  },


  depop: {
    id: "depop",
    name: "Depop",
    group: "Reselling",

    output: {
      fields: [
        "title",
        "description",
        "hashtags"
      ],

      title: {
        required: true,
        maxCharacters: 80
      },

      description: {
        required: true
      },

      hashtags: {
        required: true,
        minEntries: 3,
        maxEntries: 5
      }
    },

    promptRules: [
      "Write a concise fashion/reselling title.",
      "Write a natural, style-focused description.",
      "Generate exactly 3 to 5 relevant hashtags.",
      "Focus on style, category, aesthetic, condition and buyer intent."
    ]
  }

};


/**
 * =============================================================
 * HELPERS
 * =============================================================
 */


/**
 * Get a platform configuration.
 *
 * Throws a clear error when an unknown platform ID is supplied.
 */
export function getPlatformConfig(
  platformId
) {

  if (
    typeof platformId !== "string" ||
    !platformId.trim()
  ) {

    throw new Error(
      "A valid platform ID is required."
    );
  }


  const normalized =
    platformId
      .trim()
      .toLowerCase();


  const config =
    PLATFORM_CONFIG[
      normalized
    ];


  if (!config) {

    throw new Error(
      "Unsupported platform: " +
      platformId
    );
  }


  return config;
}


/**
 * Return all platform configurations.
 */
export function getAllPlatformConfigs() {

  return Object.values(
    PLATFORM_CONFIG
  );
}


/**
 * Return platforms grouped by category.
 */
export function getPlatformsByGroup() {

  const groups = {};


  for (
    const platform of Object.values(
      PLATFORM_CONFIG
    )
  ) {

    if (
      !groups[platform.group]
    ) {

      groups[platform.group] = [];
    }


    groups[platform.group].push(
      platform
    );
  }


  return groups;
}


/**
 * Check whether a platform exists.
 */
export function isSupportedPlatform(
  platformId
) {

  if (
    typeof platformId !== "string"
  ) {

    return false;
  }


  return Boolean(
    PLATFORM_CONFIG[
      platformId
        .trim()
        .toLowerCase()
    ]
  );
}
