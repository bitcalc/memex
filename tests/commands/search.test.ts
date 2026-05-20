import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchCommand } from "../../src/commands/search.js";
import { CardStore } from "../../src/lib/store.js";
import { MemexConfig } from "../../src/lib/config.js";

describe("searchCommand", () => {
  let tmpDir: string;
  let store: CardStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-test-"));
    const cardsDir = join(tmpDir, "cards");
    await mkdir(cardsDir, { recursive: true });
    store = new CardStore(cardsDir, join(tmpDir, "archive"));

    await writeFile(
      join(cardsDir, "jwt-migration.md"),
      `---
title: JWT Migration
created: 2026-03-18
modified: 2026-03-18
source: retro
tags:
  - auth
  - security
category: backend
---

JWT migration is about moving from sessions to tokens.

See [[stateless-auth]] for the theory behind this.`
    );

    await writeFile(
      join(cardsDir, "caching.md"),
      `---
title: Caching Strategy
created: 2026-03-18
modified: 2026-03-18
source: retro
---

Redis vs Memcached overview.

When JWT revoke fails, use cache as fallback. See [[jwt-migration]].`
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- Empty query behavior ---

  it("shows guidance text when no query (default)", async () => {
    const result = await searchCommand(store, undefined);
    expect(result.output).toContain("No query provided");
    expect(result.output).toContain("memex read index");
    expect(result.output).toContain("memex search <keyword>");
  });

  it("lists all cards when no query with list:true", async () => {
    const result = await searchCommand(store, undefined, { list: true });
    expect(result.output).toContain("jwt-migration");
    expect(result.output).toContain("JWT Migration");
    expect(result.output).toContain("caching");
    expect(result.output).toContain("Caching Strategy");
  });

  // --- Basic keyword search ---

  it("searches cards matching query in body", async () => {
    const result = await searchCommand(store, "JWT");
    expect(result.output).toContain("## jwt-migration");
    expect(result.output).toContain("JWT Migration");
    expect(result.output).toContain("[[stateless-auth]]");
  });

  it("allows security architecture queries without raw secrets", async () => {
    const result = await searchCommand(store, "JWT token rotation Bearer token");
    expect(result.exitCode).toBe(0);
  });

  it("rejects queries containing actual token values", async () => {
    const result = await searchCommand(store, "sk-proj-abc123DEF456ghi789JKL012mno345PQR");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Sensitive input rejected");
    expect(result.output).not.toContain("sk-proj");
  });

  it("warns but allows credential path queries", async () => {
    const result = await searchCommand(store, "gitee auth workflow ~/.claude/.env");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Warning:");
    expect(result.output).toContain("credential path");
  });

  it("returns empty for no matches", async () => {
    const result = await searchCommand(store, "nonexistent-term-xyz");
    expect(result.output).toBe("");
  });

  it("does NOT match non-allowlisted frontmatter fields", async () => {
    // "retro" appears in frontmatter (source: retro) but source is not in allowlist
    const result = await searchCommand(store, "retro");
    expect(result.output).toBe("");
  });

  it("is case-insensitive", async () => {
    const result = await searchCommand(store, "jwt");
    expect(result.output).toContain("## jwt-migration");
  });

  // --- OR logic and multi-word queries ---

  it("matches cards with partial token coverage (OR, not AND)", async () => {
    // "JWT rotation middleware" — only "JWT" appears in cards
    const result = await searchCommand(store, "JWT rotation middleware");
    expect(result.output).toContain("jwt-migration");
  });

  it("ranks by coverage: more matching tokens = higher rank", async () => {
    const result = await searchCommand(store, "JWT migration");
    // jwt-migration should rank first (matches both JWT and migration)
    const lines = result.output.split("\n");
    const firstHeading = lines.find(l => l.startsWith("## "));
    expect(firstHeading).toContain("jwt-migration");
  });

  // --- Tag/category search ---

  it("finds cards by tag", async () => {
    // Create a card where "security" appears only in tags, not in body
    const cardsDir = join(tmpDir, "cards");
    await writeFile(
      join(cardsDir, "infra-setup.md"),
      `---
title: Infrastructure Setup
tags:
  - security
  - devops
---

How to configure load balancers and DNS.`
    );
    store.invalidateCache();
    const result = await searchCommand(store, "security");
    expect(result.output).toContain("infra-setup");
    // Should show matched metadata since body doesn't contain "security"
    expect(result.output).toContain("Matched:");
    expect(result.output).toContain("tag");
  });

  it("finds cards by category", async () => {
    const result = await searchCommand(store, "backend");
    expect(result.output).toContain("jwt-migration");
  });

  // --- Token boundary: auth vs author ---

  it("auth does NOT match author in body text", async () => {
    const cardsDir = join(tmpDir, "cards");
    await writeFile(
      join(cardsDir, "author-guide.md"),
      `---
title: Author Guide
---

This is a guide about the author of the library.`
    );
    store.invalidateCache();
    const result = await searchCommand(store, "auth");
    // Should NOT contain author-guide (body has "author", not "auth")
    expect(result.output).not.toContain("author-guide");
  });

  // --- Limit and edge cases ---

  it("respects limit option", async () => {
    const result = await searchCommand(store, "JWT", { limit: 1 });
    const headings = result.output.match(/^## /gm) || [];
    expect(headings.length).toBe(1);
  });

  it("treats negative limit as default (not slice-from-end)", async () => {
    const result = await searchCommand(store, "JWT", { limit: -1 });
    expect(result.output).toContain("## jwt-migration");
    expect(result.output).toContain("## caching");
  });

  it("returns empty output for limit=0", async () => {
    // tokenizeQuery produces tokens but no results because limit=0
    // The search will produce scored results but slice(0, 0) = empty
    const result = await searchCommand(store, "JWT", { limit: 0 });
    expect(result.output).toBe("");
  });

  it("compact:true produces shorter output than default", async () => {
    const full = await searchCommand(store, "JWT");
    const compact = await searchCommand(store, "JWT", { compact: true });
    expect(compact.output.length).toBeLessThan(full.output.length);
    expect(compact.output).toBeTruthy();
  });

  it("compact output contains slug and title but no heading prefix", async () => {
    const result = await searchCommand(store, "JWT", { compact: true });
    expect(result.output).toContain("jwt-migration");
    expect(result.output).toContain("JWT Migration");
    expect(result.output).not.toContain("## ");
  });

  it("does not show Matched: for body hits already in first paragraph", async () => {
    // "JWT" matches in body of jwt-migration card, and the matchLine is in first paragraph
    // Should NOT show > Matched: because it's a body hit, not a metadata-only match
    const result = await searchCommand(store, "JWT");
    expect(result.output).toContain("jwt-migration");
    expect(result.output).not.toContain("Matched:");
  });

  it("CJK token finds card by title substring", async () => {
    const cardsDir = join(tmpDir, "cards");
    await writeFile(
      join(cardsDir, "install-verify.md"),
      `---
title: 安装冒烟验证
tags:
  - devops
---

This card has an English body about installation smoke testing.`
    );
    store.invalidateCache();
    const result = await searchCommand(store, "冒烟");
    expect(result.output).toContain("install-verify");
    expect(result.output).toContain("安装冒烟验证");
  });

  it("caps empty-query results at limit and shows truncation message", async () => {
    const cardsDir = join(tmpDir, "cards");
    for (let i = 0; i < 15; i++) {
      await writeFile(
        join(cardsDir, `card-${i}.md`),
        `---\ntitle: Card ${i}\n---\nContent ${i}`
      );
    }
    store.invalidateCache();
    const result = await searchCommand(store, undefined, { limit: 5, list: true });
    expect(result.output).toContain("5 of ");
    expect(result.output).toContain("cards shown");
    expect(result.totalCount).toBe(17); // 2 original + 15 new
  });

  it("shows no truncation message when all cards fit within limit", async () => {
    const result = await searchCommand(store, undefined, { limit: 50, list: true });
    expect(result.output).not.toContain("cards shown");
    expect(result.totalCount).toBe(2);
  });

  it("returns totalCount for keyword search", async () => {
    const result = await searchCommand(store, "JWT");
    expect(result.totalCount).toBeGreaterThanOrEqual(1);
  });
});

describe("searchCommand with --all flag (multi-directory)", () => {
  let tmpDir: string;
  let memexHome: string;
  let store: CardStore;
  let config: MemexConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-test-multi-"));
    memexHome = tmpDir;
    const cardsDir = join(tmpDir, "cards");
    const projectsDir = join(tmpDir, "projects");
    await mkdir(cardsDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
    store = new CardStore(cardsDir, join(tmpDir, "archive"));

    // Card in cards/
    await writeFile(
      join(cardsDir, "auth.md"),
      `---
title: Authentication
created: 2026-03-18
tags:
  - auth
---

Basic auth concepts and patterns.`
    );

    // Card in projects/
    await writeFile(
      join(projectsDir, "api-design.md"),
      `---
title: API Design
created: 2026-03-18
---

REST API design patterns.`
    );

    // Another card in projects/
    await writeFile(
      join(projectsDir, "deployment.md"),
      `---
title: Deployment Guide
created: 2026-03-18
---

How to deploy the auth service.`
    );

    config = {
      nestedSlugs: false,
      searchDirs: ["projects"],
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("searches only cards/ when --all is not set", async () => {
    const result = await searchCommand(store, "API");
    expect(result.output).not.toContain("api-design");
    expect(result.output).toBe("");
  });

  it("searches cards/ and projects/ when --all is set", async () => {
    const result = await searchCommand(store, "API", { all: true, config, memexHome });
    expect(result.output).toContain("projects/api-design");
    expect(result.output).toContain("API Design");
  });

  it("prefixes slugs with directory name when using --all", async () => {
    const result = await searchCommand(store, "auth", { all: true, config, memexHome });
    expect(result.output).toContain("cards/auth");
    expect(result.output).toContain("projects/deployment");
  });

  it("lists all cards from all directories when --all with list:true and no query", async () => {
    const result = await searchCommand(store, undefined, { all: true, config, memexHome, list: true });
    expect(result.output).toContain("cards/auth");
    expect(result.output).toContain("projects/api-design");
    expect(result.output).toContain("projects/deployment");
  });

  it("works with empty searchDirs config", async () => {
    const emptyConfig: MemexConfig = {
      nestedSlugs: false,
      searchDirs: [],
    };
    const result = await searchCommand(store, "auth", { all: true, config: emptyConfig, memexHome });
    // Empty searchDirs means only cards/ is searched, no prefix
    expect(result.output).toContain("## auth");
    expect(result.output).not.toContain("projects/");
    expect(result.output).not.toContain("cards/");
  });

  it("works with undefined searchDirs", async () => {
    const noSearchDirsConfig: MemexConfig = {
      nestedSlugs: false,
    };
    const result = await searchCommand(store, "auth", { all: true, config: noSearchDirsConfig, memexHome });
    // Undefined searchDirs means only cards/ is searched, no prefix
    expect(result.output).toContain("## auth");
    expect(result.output).not.toContain("projects/");
    expect(result.output).not.toContain("cards/");
  });
});
