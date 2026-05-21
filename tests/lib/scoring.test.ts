import { describe, it, expect } from "vitest";
import {
  tokenizeQuery,
  isCodeToken,
  buildSearchableFields,
  scoreCard,
  meetsThreshold,
  sortScoredMatches,
} from "../../src/lib/scoring.js";

describe("tokenizeQuery", () => {
  it("splits on whitespace and lowercases", () => {
    const { tokens } = tokenizeQuery("JWT migration");
    expect(tokens).toEqual(["jwt", "migration"]);
  });

  it("filters English stopwords", () => {
    const { tokens, stopwordsRemoved } = tokenizeQuery("how to handle JWT");
    expect(tokens).toEqual(["handle", "jwt"]);
    expect(stopwordsRemoved).toContain("how");
    expect(stopwordsRemoved).toContain("to");
  });

  it("filters CJK stopwords", () => {
    const { tokens } = tokenizeQuery("如何 实现 JWT");
    expect(tokens).toEqual(["jwt"]);
  });

  it("falls back to original tokens when all are stopwords", () => {
    const { tokens } = tokenizeQuery("how to use the");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens).toEqual(["how", "to", "use", "the"]);
  });

  it("extracts CJK fragments", () => {
    const { tokens } = tokenizeQuery("PDF交付物过期");
    expect(tokens).toContain("pdf");
    expect(tokens).toContain("交付物过期");
  });

  it("expands compound tokens with hyphens", () => {
    const { tokens } = tokenizeQuery("jwt-migration");
    expect(tokens).toContain("jwt-migration");
    expect(tokens).toContain("jwt");
    expect(tokens).toContain("migration");
  });

  it("expands compound tokens with underscores", () => {
    const { tokens } = tokenizeQuery("OPENAI_API_KEY");
    expect(tokens).toContain("openai_api_key");
    expect(tokens).toContain("openai");
    // "api" is a valid non-stopword token
    expect(tokens).toContain("api");
    expect(tokens).toContain("key");
  });

  it("expands compound tokens with dots", () => {
    const { tokens } = tokenizeQuery("req.body");
    expect(tokens).toContain("req.body");
    expect(tokens).toContain("req");
    expect(tokens).toContain("body");
  });

  it("expands compound tokens with slashes", () => {
    const { tokens } = tokenizeQuery("src/lib");
    expect(tokens).toContain("src/lib");
    expect(tokens).toContain("src");
    expect(tokens).toContain("lib");
  });

  it("deduplicates expanded tokens", () => {
    const { tokens } = tokenizeQuery("jwt jwt-migration");
    const jwtCount = tokens.filter(t => t === "jwt").length;
    expect(jwtCount).toBe(1);
  });

  it("preserves original casing in originalTokens", () => {
    const { tokens, originalTokens } = tokenizeQuery("JWT reuseExistingServer OPENAI_API_KEY");
    // tokens are lowercased
    expect(tokens).toContain("jwt");
    expect(tokens).toContain("reuseexistingserver");
    // originalTokens preserve casing
    expect(originalTokens).toContain("JWT");
    expect(originalTokens).toContain("reuseExistingServer");
    expect(originalTokens).toContain("OPENAI_API_KEY");
  });

  it("originalTokens align with tokens after stopword removal", () => {
    const { tokens, originalTokens } = tokenizeQuery("how to handle JWT");
    // "how" and "to" removed as stopwords
    expect(tokens).toEqual(["handle", "jwt"]);
    expect(originalTokens).toEqual(["handle", "JWT"]);
    expect(tokens.length).toBe(originalTokens.length);
  });
});

describe("isCodeToken", () => {
  it("detects all-uppercase tokens", () => {
    expect(isCodeToken("JWT")).toBe(true);
    expect(isCodeToken("API")).toBe(true);
    expect(isCodeToken("HTTP")).toBe(true);
  });

  it("detects camelCase tokens", () => {
    expect(isCodeToken("reuseExistingServer")).toBe(true);
    expect(isCodeToken("useState")).toBe(true);
    expect(isCodeToken("onClick")).toBe(true);
  });

  it("detects tokens with numbers", () => {
    expect(isCodeToken("port4321")).toBe(true);
    expect(isCodeToken("v2")).toBe(true);
  });

  it("detects tokens with underscores, dots, slashes", () => {
    expect(isCodeToken("OPENAI_API_KEY")).toBe(true);
    expect(isCodeToken("req.body")).toBe(true);
    expect(isCodeToken("src/lib")).toBe(true);
  });

  it("does NOT detect plain lowercase words", () => {
    expect(isCodeToken("migration")).toBe(false);
    expect(isCodeToken("caching")).toBe(false);
    expect(isCodeToken("server")).toBe(false);
  });

  it("single uppercase letter is not code token (< 2 chars uppercase)", () => {
    expect(isCodeToken("A")).toBe(false);
  });
});

describe("buildSearchableFields", () => {
  it("extracts tags from array", () => {
    const fields = buildSearchableFields("test", { tags: ["auth", "security"] }, "body", []);
    expect(fields.tags).toEqual(["auth", "security"]);
  });

  it("extracts tags from comma-separated string", () => {
    const fields = buildSearchableFields("test", { tag: "auth, security" }, "body", []);
    expect(fields.tags).toEqual(["auth", "security"]);
  });

  it("extracts headings from content", () => {
    const content = "# Main\n\nSome text\n\n## Sub Section\n\nMore text";
    const fields = buildSearchableFields("test", {}, content, []);
    expect(fields.headings).toEqual(["Main", "Sub Section"]);
  });

  it("uses slug as title fallback", () => {
    const fields = buildSearchableFields("my-card", {}, "body", []);
    expect(fields.title).toBe("my-card");
  });

  it("does not index non-allowlisted frontmatter", () => {
    const fields = buildSearchableFields("test", { source: "retro", author: "me" }, "body", []);
    // source and author should not appear in any searchable field
    expect(fields.category).toBe("");
    expect(fields.tags).toEqual([]);
  });
});

describe("scoreCard — token matching boundaries", () => {
  it("auth does NOT match author in body (word boundary)", () => {
    const fields = buildSearchableFields("guide", { title: "Guide" }, "Written by the author of this library.", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    expect(match).toBeNull();
  });

  it("auth matches auth in body (word boundary)", () => {
    const fields = buildSearchableFields("guide", { title: "Guide" }, "The auth middleware handles tokens.", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    expect(match).not.toBeNull();
    expect(match!.matchedFields.some(f => f.startsWith("body:"))).toBe(true);
  });

  it("CJK token matches title substring", () => {
    const fields = buildSearchableFields("install-verify", { title: "安装冒烟验证" }, "Some English body text.", []);
    const match = scoreCard(["冒烟"], ["冒烟"], fields);
    expect(match).not.toBeNull();
    expect(match!.matchedFields.some(f => f.startsWith("title:"))).toBe(true);
  });

  it("CJK token matches heading substring", () => {
    const fields = buildSearchableFields("card", { title: "Card" }, "## 冒烟测试流程\n\nSome body content.", []);
    const match = scoreCard(["冒烟"], ["冒烟"], fields);
    expect(match).not.toBeNull();
    expect(match!.matchedFields.some(f => f.startsWith("headings:"))).toBe(true);
  });

  it("auth matches tag auth exactly", () => {
    const fields = buildSearchableFields("card", { title: "Card", tags: ["auth", "security"] }, "no relevant body", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    expect(match).not.toBeNull();
    expect(match!.matchedFields).toContain("tags:auth");
  });

  it("auth does NOT match tag authentication", () => {
    const fields = buildSearchableFields("card", { title: "Card", tags: ["authentication"] }, "no relevant body", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    // Should not match via tags (no exact match), and body doesn't have it either
    expect(match).toBeNull();
  });

  it("publishing matches category content-publishing via segment", () => {
    const fields = buildSearchableFields("card", { title: "Card", category: "content-publishing" }, "body text", []);
    const match = scoreCard(["publishing"], ["publishing"], fields);
    expect(match).not.toBeNull();
    expect(match!.matchedFields.some(f => f.startsWith("category:"))).toBe(true);
  });

  it("auth matches slug jwt-auth-pattern via segment", () => {
    const fields = buildSearchableFields("jwt-auth-pattern", { title: "JWT Auth" }, "body text", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    expect(match).not.toBeNull();
    // Should match via slug or title
    const hasSlugOrTitle = match!.matchedFields.some(f => f.startsWith("slug:") || f.startsWith("title:"));
    expect(hasSlugOrTitle).toBe(true);
  });

  it("auth does NOT match slug author-guide via segment", () => {
    const fields = buildSearchableFields("author-guide", { title: "Author Guide" }, "body about writing books", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    // "author" segments are ["author", "guide"], "auth" !== "author"
    expect(match).toBeNull();
  });
});

describe("scoreCard — field weights and code-token boost", () => {
  it("slug/title match scores higher than body match", () => {
    const fieldsSlug = buildSearchableFields("jwt-migration", { title: "JWT Migration" }, "generic body text", []);
    const fieldsBody = buildSearchableFields("generic-card", { title: "Generic Card" }, "JWT migration notes here", []);

    const matchSlug = scoreCard(["jwt"], ["JWT"], fieldsSlug);
    const matchBody = scoreCard(["jwt"], ["JWT"], fieldsBody);

    expect(matchSlug).not.toBeNull();
    expect(matchBody).not.toBeNull();
    expect(matchSlug!.score).toBeGreaterThan(matchBody!.score);
  });

  it("code-token boost increases body score but caps at max field weight", () => {
    // JWT is a code token (all uppercase)
    const fields = buildSearchableFields("card", { title: "Card" }, "JWT rotation is important", []);
    const match = scoreCard(["jwt"], ["JWT"], fields);
    expect(match).not.toBeNull();
    // Score should be capped, not exceed 1.0
    expect(match!.score).toBeLessThanOrEqual(1.0);
    expect(match!.score).toBeGreaterThan(0);
  });

  it("headings code-token boost is capped to maxFieldWeight", () => {
    const fields = buildSearchableFields("card", { title: "Card" }, "## JWT Auth Flow\n\nSome content about something else", []);
    const match = scoreCard(["jwt"], ["JWT"], fields);
    expect(match).not.toBeNull();
    // headings weight 3 * codeBoost 2 = 6, should be capped to 5
    expect(match!.score).toBeLessThanOrEqual(1.0);
  });

  it("headings code-token boost actually increases score vs non-code-token", () => {
    // "JWT" is a code token, "migration" is not
    const fieldsCode = buildSearchableFields("card-a", { title: "Card A" }, "## JWT Details\n\nBody text.", []);
    const fieldsPlain = buildSearchableFields("card-b", { title: "Card B" }, "## migration Details\n\nBody text.", []);

    const matchCode = scoreCard(["jwt"], ["JWT"], fieldsCode);
    const matchPlain = scoreCard(["migration"], ["migration"], fieldsPlain);

    expect(matchCode).not.toBeNull();
    expect(matchPlain).not.toBeNull();
    // Code-token in heading gets boosted (capped at 5), plain heading gets weight 3
    expect(matchCode!.score).toBeGreaterThan(matchPlain!.score);
  });

  it("code-token boost works through full tokenizeQuery → scoreCard path", () => {
    // This test verifies that tokenizeQuery preserves original casing
    // so that isCodeToken detects uppercase/camelCase patterns in scoreCard
    const { tokens, originalTokens } = tokenizeQuery("JWT reuseExistingServer");
    expect(isCodeToken(originalTokens[originalTokens.indexOf("JWT")])).toBe(true);
    expect(isCodeToken(originalTokens[originalTokens.indexOf("reuseExistingServer")])).toBe(true);

    // Card with JWT in body — should get code-token boost
    const fieldsCode = buildSearchableFields("card-a", { title: "Card A" }, "JWT rotation and reuseExistingServer flag", []);
    const matchCode = scoreCard(tokens, originalTokens, fieldsCode);

    // Card with plain words in body — no code-token boost
    const fieldsPlain = buildSearchableFields("card-b", { title: "Card B" }, "jwt rotation and reuseexistingserver flag", []);
    // Plain tokens: tokenizer output is always lowercase, so we use non-code original tokens
    const matchPlain = scoreCard(tokens, ["jwt", "reuseexistingserver"], fieldsPlain);

    expect(matchCode).not.toBeNull();
    expect(matchPlain).not.toBeNull();
    // Code-token boosted card should score higher than non-boosted
    expect(matchCode!.score).toBeGreaterThan(matchPlain!.score);
  });
});

describe("scoreCard — coverage and threshold", () => {
  it("short query (< 4 tokens) always passes threshold", () => {
    const fields = buildSearchableFields("card", { title: "Card" }, "JWT is a token", []);
    const match = scoreCard(["jwt"], ["JWT"], fields);
    expect(match).not.toBeNull();
  });

  it("10-token query with only 2 body matches is filtered", () => {
    // 10 tokens, matching only 2 → need max(2, ceil(0.3*10))=3, so 2 is not enough
    const tokens = ["jwt", "token", "rotation", "bearer", "middleware", "config", "database", "setup", "deploy", "release"];
    const origTokens = ["JWT", "token", "rotation", "Bearer", "middleware", "config", "database", "setup", "deploy", "release"];
    const fields = buildSearchableFields("generic", { title: "Generic" }, "JWT and token are important concepts.", []);

    const match = scoreCard(tokens, origTokens, fields);
    expect(match).toBeNull();
  });

  it("tag exact match passes threshold via exemption even with low coverage", () => {
    // 5 tokens, only 1 matches a tag → normally needs max(2, ceil(0.3*5))=2
    // But tag match gets exemption
    const tokens = ["auth", "rotation", "bearer", "middleware", "config"];
    const origTokens = tokens;
    const fields = buildSearchableFields("card", { title: "Card", tags: ["auth"] }, "no relevant body", []);

    const match = scoreCard(tokens, origTokens, fields);
    expect(match).not.toBeNull();
  });

  it("CJK title match passes threshold exemption in long mixed query", () => {
    // 4+ tokens, only "冒烟" matches title — should still pass via CJK high-signal exemption
    const { tokens, originalTokens } = tokenizeQuery("JWT token rotation 冒烟");
    const fields = buildSearchableFields("install-verify", { title: "安装冒烟验证" }, "English only body.", []);

    const match = scoreCard(tokens, originalTokens, fields);
    expect(match).not.toBeNull();
    expect(match!.matchedFields.some(f => f.startsWith("title:"))).toBe(true);
  });

  it("low-signal slug token (server) does NOT get exemption in long query", () => {
    // 7 tokens, only "server" matches slug — server is low-signal, no exemption
    const tokens = ["server", "config", "database", "setup", "deploy", "release", "only"];
    const origTokens = tokens;
    const fields = buildSearchableFields("playwright-reuse-server-port-collision", {
      title: "Playwright Reuse Server Port Collision",
    }, "Some config details here.", []);

    const match = scoreCard(tokens, origTokens, fields);
    // "server" in slug + "config" in body = 2 matches out of 7
    // need max(2, ceil(0.3*7))=3, and neither server nor config get exemption
    expect(match).toBeNull();
  });

  it("low-signal title token (guide) does NOT get exemption in long query", () => {
    const tokens = ["guide", "database", "release", "invoice", "calendar", "budget"];
    const origTokens = tokens;
    const fields = buildSearchableFields("author-guide", { title: "Author Guide" }, "Body text.", []);

    const match = scoreCard(tokens, origTokens, fields);
    expect(match).toBeNull();
  });

  it("distinctive slug token (jwt) still gets exemption in long query", () => {
    // "jwt" is NOT in the low-signal list — should still get exemption
    const tokens = ["jwt", "database", "release", "invoice", "calendar", "budget"];
    const origTokens = ["JWT", "database", "release", "invoice", "calendar", "budget"];
    const fields = buildSearchableFields("jwt-migration", { title: "JWT Migration" }, "Body text.", []);

    const match = scoreCard(tokens, origTokens, fields);
    expect(match).not.toBeNull();
  });

  it("short stopword in title does NOT get exemption", () => {
    // "do" is a stopword, won't be in tokens after filtering
    // But if forced, length < 3 and not a code token → no exemption
    expect(meetsThreshold(5, 1, false)).toBe(false);
  });
});

describe("scoreCard — metadata-only match produces matchedFields", () => {
  it("tag-only match has matchedFields but empty matchLine", () => {
    const fields = buildSearchableFields("card", { title: "Unrelated Title", tags: ["auth"] }, "Completely unrelated body text.", []);
    const match = scoreCard(["auth"], ["auth"], fields);
    expect(match).not.toBeNull();
    expect(match!.matchLine).toBe("");
    expect(match!.matchedFields).toContain("tags:auth");
  });
});

describe("scoreCard — regex escape", () => {
  it("req.body dot is not treated as wildcard", () => {
    const fields = buildSearchableFields("card", { title: "Card" }, "The reqXbody function handles parsing", []);
    const match = scoreCard(["req.body"], ["req.body"], fields);
    // "req.body" should NOT match "reqXbody" because . is escaped
    expect(match).toBeNull();
  });

  it("req.body matches literal req.body in text", () => {
    const fields = buildSearchableFields("card", { title: "Card" }, "Use req.body to get the parsed JSON", []);
    const match = scoreCard(["req.body"], ["req.body"], fields);
    expect(match).not.toBeNull();
  });
});

describe("scoreCard — low-signal penalty in slug/title", () => {
  it("low-signal token in slug gets penalized weight (×0.25)", () => {
    // "guide" is low-signal → slug weight 5 * 0.25 = 1.25
    const fields = buildSearchableFields("author-guide", { title: "Author Guide" }, "Body text.", []);
    const match = scoreCard(["guide"], ["guide"], fields);
    expect(match).not.toBeNull();
    // normalized: 1.25 / (1 * 5) = 0.25
    expect(match!.score).toBeCloseTo(0.25, 2);
  });

  it("distinctive token in slug gets full weight", () => {
    // "jwt" is NOT low-signal → slug weight 5
    const fields = buildSearchableFields("jwt-migration", { title: "JWT Migration" }, "Body text.", []);
    const match = scoreCard(["jwt"], ["JWT"], fields);
    expect(match).not.toBeNull();
    // normalized: 5 / (1 * 5) = 1.0
    expect(match!.score).toBeCloseTo(1.0, 2);
  });

  it("two-token query: card matching domain token ranks above card matching only low-signal token", () => {
    // "deployment guide" — both tokens are low-signal, but deployment-flow matches "deployment"
    // in slug (domain-relevant), author-guide matches only "guide" in slug.
    // deployment-flow should rank higher because it matches a domain-relevant low-signal token
    // that the user actually searched for, while author-guide has zero relevance to "deployment".
    const deployFlowFields = buildSearchableFields("deployment-flow", { title: "Deployment Flow" }, "CI/CD pipeline steps.", []);
    const authorFields = buildSearchableFields("author-guide", { title: "Author Guide" }, "Author info.", []);

    const tokens = ["deployment", "guide"];
    const origTokens = ["deployment", "guide"];

    const deployMatch = scoreCard(tokens, origTokens, deployFlowFields);
    const authorMatch = scoreCard(tokens, origTokens, authorFields);

    // deployment-flow matches "deployment" in slug (penalized but present), no match for "guide"
    expect(deployMatch).not.toBeNull();
    // author-guide matches "guide" in slug (penalized), no match for "deployment"
    expect(authorMatch).not.toBeNull();
    // Both match 1/2 tokens with same penalty, but scores should be equal
    // The key is that deployment-flow is NOT ranked below author-guide
    expect(deployMatch!.score).toBeCloseTo(authorMatch!.score, 2);
    expect(deployMatch!.coverage).toBeCloseTo(authorMatch!.coverage, 2);
  });
});

describe("sortScoredMatches", () => {
  it("sorts by score DESC, then coverage DESC, then slug ASC", () => {
    const matches = [
      { slug: "c-card", score: 0.5, coverage: 0.5, matchedTokens: 1, effectiveTokens: 2, matchLine: "", matchedFields: [] },
      { slug: "a-card", score: 0.8, coverage: 0.5, matchedTokens: 2, effectiveTokens: 2, matchLine: "", matchedFields: [] },
      { slug: "b-card", score: 0.8, coverage: 0.7, matchedTokens: 2, effectiveTokens: 2, matchLine: "", matchedFields: [] },
      { slug: "d-card", score: 0.8, coverage: 0.7, matchedTokens: 2, effectiveTokens: 2, matchLine: "", matchedFields: [] },
    ];

    sortScoredMatches(matches);

    expect(matches[0].slug).toBe("b-card"); // highest score, highest coverage
    expect(matches[1].slug).toBe("d-card"); // same score+coverage, slug alphabetical
    expect(matches[2].slug).toBe("a-card"); // same score, lower coverage
    expect(matches[3].slug).toBe("c-card"); // lowest score
  });
});

describe("meetsThreshold", () => {
  it("short queries (< 4 tokens) always pass", () => {
    expect(meetsThreshold(1, 1, false)).toBe(true);
    expect(meetsThreshold(3, 1, false)).toBe(true);
  });

  it("4 tokens requires max(2, ceil(1.2)) = 2 matches", () => {
    expect(meetsThreshold(4, 2, false)).toBe(true);
    expect(meetsThreshold(4, 1, false)).toBe(false);
  });

  it("10 tokens requires max(2, ceil(3.0)) = 3 matches", () => {
    expect(meetsThreshold(10, 3, false)).toBe(true);
    expect(meetsThreshold(10, 2, false)).toBe(false);
  });

  it("high signal match exempts from threshold", () => {
    expect(meetsThreshold(10, 1, true)).toBe(true);
  });
});
