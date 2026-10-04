// A fake GitHub REST API for zero-cost tests of `src/github/` and the E2E specs (Phase 4, P4-o).
// In unit tests: `createFakeGitHub()` and pass `fake.fetch`. For `wrangler dev`: `pnpm fake-github`
// (port 8789) and point GITHUB_API_URL in .dev.vars at http://localhost:8789.
//
// It holds one repo in memory: blobs, trees, commits, branch refs, pull requests, reviews and review
// comments. Tokens decide who acts: `ghs_…` is the App bot, `github_pat_…` is TseHang.
//
// Control routes (HTTP server only): POST /__reset, GET /__state, POST /__fail, POST /__pull, POST /__comment.

import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const FAKE_REPO = "TseHang/andrun-demo";
export const BOT = "andrun[bot]";
export const HUMAN = "TseHang";
export const FAKE_PAT = "github_pat_fake";
/** The commit TseHang/andrun-demo really has, so the tarball download works in E2E. */
export const DEMO_SHA = "0df6f53ec8a51785899d574c43db212513347537";

export interface FakeFile {
  filename: string;
  status: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** Set for a pull request from a fork. */
  headRepo?: string;
  /** Overrides the files computed from the trees. */
  files?: FakeFile[];
  /** Overrides `changed_files`, for a pull request with more files than one page returns. */
  changedFiles?: number;
  updatedAt: string;
}

export interface FakeReview {
  id: number;
  pull: number;
  user: string;
  commit_id: string;
  event: string;
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
}

export interface FakeComment {
  id: number;
  pull: number;
  user: string;
  path: string;
  line: number;
  body: string;
  in_reply_to_id?: number;
  created_at: string;
}

interface Failure {
  method?: string;
  path: RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
}

type Tree = Record<string, { mode: string; sha: string }>;

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

let keys: { privateKey: string; publicKey: string } | undefined;
/** A throwaway RSA key pair: the private key is PKCS#8 PEM, as the Worker secret must be. */
export function testKeys() {
  keys ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return keys;
}

/** Line numbers on the right side of a unified patch that can take a review comment. */
function rightLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let n = 0;
  for (const l of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) n = Number(hunk[1]);
    else if (l.startsWith("+") || l.startsWith(" ")) lines.add(n++);
  }
  return lines;
}

export function createFakeGitHub(seed: { files?: Record<string, string>; modes?: Record<string, string>; baseSha?: string; defaultBranch?: string } = {}) {
  const defaultBranch = seed.defaultBranch ?? "main";
  const blobs = new Map<string, string>();
  const trees = new Map<string, Tree>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string; author: string }>();
  const refs = new Map<string, string>();
  const pulls: FakePull[] = [];
  const reviews: FakeReview[] = [];
  const comments: FakeComment[] = [];
  const requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const jwts: string[] = [];
  const failures: Failure[] = [];
  let tokens = 0;
  let ids = 100;
  let clock = Date.parse("2026-10-03T00:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();

  const putBlob = (content: string) => {
    const sha = sha1(`blob:${content}`);
    blobs.set(sha, content);
    return sha;
  };
  const putTree = (tree: Tree) => {
    const sha = sha1(`tree:${JSON.stringify(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1)))}`);
    trees.set(sha, tree);
    return sha;
  };
  const putCommit = (c: { tree: string; parents: string[]; message: string; author: string }, forced?: string) => {
    const sha = forced ?? sha1(`commit:${JSON.stringify(c)}`);
    commits.set(sha, c);
    return sha;
  };

  function reset(): void {
    for (const m of [blobs, trees, commits, refs]) m.clear();
    for (const a of [pulls, reviews, comments, requests, jwts, failures]) a.length = 0;
    const tree: Tree = {};
    for (const [path, content] of Object.entries(seed.files ?? { "README.md": "# demo\n" })) tree[path] = { mode: seed.modes?.[path] ?? "100644", sha: putBlob(content) };
    refs.set(defaultBranch, putCommit({ tree: putTree(tree), parents: [], message: "init", author: HUMAN }, seed.baseSha));
  }
  reset();

  /** The files of a commit, path → content. */
  function filesAt(commitSha: string): Record<string, string> {
    const tree = trees.get(commits.get(commitSha)?.tree ?? "") ?? {};
    return Object.fromEntries(Object.entries(tree).map(([path, e]) => [path, blobs.get(e.sha) ?? ""]));
  }

  function filesOf(pull: FakePull): FakeFile[] {
    if (pull.files) return pull.files;
    const base = filesAt(refs.get(pull.baseRef) ?? "");
    const head = filesAt(pull.headSha);
    const out: FakeFile[] = [];
    for (const path of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
      const before = base[path];
      const after = head[path];
      if (before === after) continue;
      const del = before === undefined ? [] : before.replace(/\n$/, "").split("\n");
      const add = after === undefined ? [] : after.replace(/\n$/, "").split("\n");
      out.push({
        filename: path,
        status: before === undefined ? "added" : after === undefined ? "removed" : "modified",
        additions: add.length,
        deletions: del.length,
        patch: [`@@ -${del.length ? 1 : 0},${del.length} +${add.length ? 1 : 0},${add.length} @@`, ...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`)].join("\n"),
      });
    }
    return out;
  }

  function addPull(p: Partial<FakePull> & { title: string; headRef: string }): FakePull {
    const number = p.number ?? Math.max(11, ...pulls.map((x) => x.number)) + 1;
    const pull: FakePull = {
      number,
      body: "",
      state: "open",
      user: BOT,
      headSha: refs.get(p.headRef) ?? refs.get(defaultBranch)!,
      baseRef: defaultBranch,
      updatedAt: tick(),
      ...p,
    };
    pulls.push(pull);
    return pull;
  }

  function addComment(c: Omit<FakeComment, "id" | "created_at"> & { id?: number }): FakeComment {
    const comment = { id: c.id ?? ++ids, created_at: tick(), ...c };
    comments.push(comment);
    return comment;
  }

  const pullJson = (p: FakePull, detail = false) => {
    const files = detail ? filesOf(p) : [];
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      html_url: `https://github.com/${FAKE_REPO}/pull/${p.number}`,
      user: { login: p.user },
      head: { ref: p.headRef, sha: p.headSha, repo: { full_name: p.headRepo ?? FAKE_REPO } },
      base: { ref: p.baseRef, repo: { full_name: FAKE_REPO } },
      updated_at: p.updatedAt,
      created_at: p.updatedAt,
      ...(detail && {
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        changed_files: p.changedFiles ?? files.length,
      }),
    };
  };
  const commentJson = (c: FakeComment) => ({
    id: c.id,
    user: { login: c.user },
    path: c.path,
    line: c.line,
    body: c.body,
    created_at: c.created_at,
    html_url: `https://github.com/${FAKE_REPO}/pull/${c.pull}#discussion_r${c.id}`,
    ...(c.in_reply_to_id !== undefined && { in_reply_to_id: c.in_reply_to_id }),
  });

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const err = (status: number, message: string) => json({ message }, status);

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/+$/, "");
    const auth = request.headers.get("authorization")?.replace(/^(Bearer|token)\s+/i, "") ?? null;
    const text = method === "GET" ? "" : await request.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    requests.push({ method, path: path + url.search, auth, body: text ? body : null });

    const failure = failures.find((f) => f.times > 0 && (!f.method || f.method === method) && f.path.test(path));
    if (failure) {
      failure.times--;
      return json(failure.body ?? { message: "fake failure" }, failure.status, failure.headers);
    }

    const tokenRoute = /^\/app\/installations\/(\w+)\/access_tokens$/.exec(path);
    if (tokenRoute && method === "POST") {
      if (!auth || auth.split(".").length !== 3) return err(401, "A JSON web token could not be decoded");
      jwts.push(auth);
      return json({ token: `ghs_fake_${++tokens}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }

    // The App itself, asked with the JWT: its slug gives the bot's login (`<slug>[bot]`).
    if (path === "/app" && method === "GET") {
      return auth && auth.split(".").length === 3 ? json({ slug: BOT.replace("[bot]", "") }) : err(401, "A JSON web token could not be decoded");
    }

    if (!auth) return err(401, "Requires authentication");
    const actor = auth.startsWith("ghs_") ? BOT : auth.startsWith("github_pat_") ? HUMAN : null;
    if (!actor) return err(401, "Bad credentials");
    const prefix = `/repos/${FAKE_REPO}`;
    if (!path.startsWith(prefix)) return err(404, "Not Found");
    const rest = path.slice(prefix.length);
    let m: RegExpExecArray | null;

    if (rest === "" && method === "GET") return json({ full_name: FAKE_REPO, default_branch: defaultBranch });

    // ---------- Git data ----------
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      const sha = refs.get(m[1]!);
      return sha ? json({ ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : err(404, "Not Found");
    }
    if ((m = /^\/git\/commits\/(\w+)$/.exec(rest)) && method === "GET") {
      const c = commits.get(m[1]!);
      return c ? json({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : err(404, "Not Found");
    }
    if ((m = /^\/git\/trees\/(\w+)$/.exec(rest)) && method === "GET") {
      const t = trees.get(m[1]!);
      if (!t) return err(404, "Not Found");
      return json({ sha: m[1], truncated: false, tree: Object.entries(t).map(([p, e]) => ({ path: p, mode: e.mode, type: "blob", sha: e.sha })) });
    }
    if (rest === "/git/blobs" && method === "POST") {
      const content = body.encoding === "base64" ? Buffer.from(String(body.content), "base64").toString("utf8") : String(body.content);
      return json({ sha: putBlob(content) }, 201);
    }
    if (rest === "/git/trees" && method === "POST") {
      const base = body.base_tree ? trees.get(String(body.base_tree)) : {};
      if (!base) return err(422, "base_tree is not a valid tree");
      const tree: Tree = { ...base };
      for (const e of body.tree as { path: string; mode: string; sha?: string | null; content?: string }[]) {
        if (e.sha === null) delete tree[e.path];
        else if (e.content !== undefined) tree[e.path] = { mode: e.mode, sha: putBlob(e.content) };
        else if (e.sha && blobs.has(e.sha)) tree[e.path] = { mode: e.mode, sha: e.sha };
        else return err(422, `tree.sha ${String(e.sha)} is not a valid blob`);
      }
      return json({ sha: putTree(tree) }, 201);
    }
    if (rest === "/git/commits" && method === "POST") {
      if (!trees.has(String(body.tree))) return err(422, "Tree SHA does not exist");
      const parents = (body.parents ?? []) as string[];
      if (parents.some((p) => !commits.has(p))) return err(422, "Parent SHA does not exist");
      const author = (body.author as { name?: string } | undefined)?.name ?? actor;
      const sha = putCommit({ tree: String(body.tree), parents, message: String(body.message), author });
      return json({ sha, tree: { sha: body.tree } }, 201);
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(name)) return err(422, "Reference already exists");
      if (!commits.has(String(body.sha))) return err(422, "Object does not exist");
      refs.set(name, String(body.sha));
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "PATCH") {
      const current = refs.get(m[1]!);
      if (!current) return err(422, "Reference does not exist");
      const isAncestor = (sha: string): boolean => sha === current || (commits.get(sha)?.parents ?? []).some(isAncestor);
      if (!body.force && !isAncestor(String(body.sha))) return err(422, "Update is not a fast forward");
      refs.set(m[1]!, String(body.sha));
      for (const p of pulls) if (p.headRef === m[1] && p.state === "open") Object.assign(p, { headSha: String(body.sha), updatedAt: tick() });
      return json({ ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }

    // ---------- Pull requests ----------
    if (rest === "/pulls" && method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const head = url.searchParams.get("head")?.split(":")[1];
      const list = pulls.filter((p) => (state === "all" || p.state === state) && (!head || p.headRef === head));
      return json([...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((p) => pullJson(p)));
    }
    if (rest === "/pulls" && method === "POST") {
      const headRef = String(body.head);
      const headSha = refs.get(headRef);
      if (!headSha) return err(422, "Validation Failed: head is invalid");
      if (!refs.has(String(body.base))) return err(422, "Validation Failed: base is invalid");
      if (pulls.some((p) => p.headRef === headRef && p.state === "open")) return err(422, "A pull request already exists for this head");
      const pull = addPull({ title: String(body.title), body: String(body.body ?? ""), headRef, headSha, baseRef: String(body.base), user: actor });
      return json(pullJson(pull, true), 201);
    }
    if ((m = /^\/pulls\/(\d+)(\/files|\/reviews|\/comments(?:\/(\d+)\/replies)?)?$/.exec(rest))) {
      const pull = pulls.find((p) => p.number === Number(m![1]));
      if (!pull) return err(404, "Not Found");
      const sub = m[2] ?? "";
      if (sub === "" && method === "GET") return json(pullJson(pull, true));
      if (sub === "/files" && method === "GET") return json(filesOf(pull));
      if (sub === "/reviews" && method === "POST") {
        const event = String(body.event);
        if (actor === pull.user && event !== "COMMENT") {
          return err(422, `Unprocessable Entity: Can not ${event === "APPROVE" ? "approve" : "request changes on"} your own pull request`);
        }
        const list = (body.comments ?? []) as FakeReview["comments"];
        const files = filesOf(pull);
        for (const c of list) {
          if (!rightLines(files.find((f) => f.filename === c.path)?.patch).has(c.line)) {
            return err(422, "Unprocessable Entity: Pull request review thread line must be part of the diff");
          }
        }
        if (list.length === 0 && !String(body.body ?? "").trim() && event !== "APPROVE") return err(422, "Unprocessable Entity: body is required");
        const review: FakeReview = { id: ++ids, pull: pull.number, user: actor, commit_id: String(body.commit_id), event, body: String(body.body ?? ""), comments: list };
        reviews.push(review);
        for (const c of list) addComment({ pull: pull.number, user: actor, path: c.path, line: c.line, body: c.body });
        return json({ id: review.id, state: event, html_url: `https://github.com/${FAKE_REPO}/pull/${pull.number}#pullrequestreview-${review.id}` });
      }
      if (sub === "/comments" && method === "GET") return json(comments.filter((c) => c.pull === pull.number).map(commentJson));
      if (m[3] && method === "POST") {
        const parent = comments.find((c) => c.id === Number(m![3]) && c.pull === pull.number);
        if (!parent) return err(404, "Not Found");
        if (!String(body.body ?? "").trim()) return err(422, "Unprocessable Entity: body is required");
        const reply = addComment({ pull: pull.number, user: actor, path: parent.path, line: parent.line, body: String(body.body), in_reply_to_id: parent.id });
        return json(commentJson(reply), 201);
      }
    }
    return err(404, "Not Found");
  }

  const fetchFake = ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input as RequestInfo, init))) as typeof fetch;

  return {
    fetch: fetchFake,
    handle,
    reset,
    defaultBranch,
    blobs,
    refs,
    commits,
    pulls,
    reviews,
    comments,
    requests,
    jwts,
    filesAt,
    /** The tree of a commit, path → mode and blob sha. */
    treeAt: (commitSha: string): Tree => trees.get(commits.get(commitSha)?.tree ?? "") ?? {},
    putCommit,
    putTree,
    filesOf,
    addPull,
    addComment,
    /** The next matching requests answer with this status instead (`times`, default 1). */
    fail(f: Omit<Failure, "times"> & { times?: number }): void {
      failures.push({ times: 1, ...f });
    },
    /** Requests that changed something, as "METHOD path". */
    writes: () => requests.filter((r) => r.method !== "GET" && !r.path.includes("/access_tokens")).map((r) => `${r.method} ${r.path}`),
  };
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;

// ---------- HTTP server for `wrangler dev` and the E2E specs ----------

/** What the E2E specs start from: `main` at the demo repo's real commit. */
export const E2E_SEED = {
  baseSha: DEMO_SHA,
  files: { "README.md": "# andrun-demo\n", "src/sum.js": "export function sum(values) {\n  return 0;\n}\n" },
};

export function startFakeGitHub(port: number) {
  const fake = createFakeGitHub(E2E_SEED);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const url = `http://localhost:${port}${req.url ?? "/"}`;
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
          res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
        const control = (req.url ?? "").split("?")[0];
        const data = (raw ? JSON.parse(raw) : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (control === "/__reset") return fake.reset(), send(200, { ok: true });
        if (control === "/__state") {
          return send(200, {
            refs: Object.fromEntries(fake.refs),
            pulls: fake.pulls,
            reviews: fake.reviews,
            comments: fake.comments,
            writes: fake.writes(),
            authors: Object.fromEntries([...fake.commits].map(([sha, c]) => [sha, c.author])),
          });
        }
        if (control === "/__fail") return fake.fail({ ...data, path: new RegExp(String(data.path)) } as never), send(200, { ok: true });
        if (control === "/__pull") return send(200, fake.addPull(data as never));
        if (control === "/__comment") return send(200, fake.addComment(data as never));
        const response = await fake.handle(
          new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(raw && { body: raw }) }),
        );
        console.log(`[fake-github] ${req.method} ${req.url} → ${response.status}`);
        send(response.status, await response.json(), Object.fromEntries(response.headers));
      })().catch((e: unknown) => {
        console.error("[fake-github]", e);
        res.destroy();
      });
    });
  });
  server.listen(port, () => console.log(`[fake-github] listening on http://localhost:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFakeGitHub(Number(process.env["PORT"] ?? 8789));
}
