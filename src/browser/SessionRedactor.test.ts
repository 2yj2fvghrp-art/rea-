import { expect, it } from "vitest";

import { declaredQueryValues, SessionRedactor } from "./SessionRedactor.js";

const MARKER = encodeURIComponent("[REDACTED:value-1]");

/** Every value a consumer recovers by parsing a URL, its query and nested query URLs. */
const recovered = (url: string, depth = 2): string[] => {
  if (!URL.canParse(url)) return [url];
  const parsed = new URL(url);
  const values = [
    parsed.hostname,
    ...parsed.pathname.split("/").map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    }),
    ...[...parsed.searchParams].flat(),
    ...[...new URLSearchParams(parsed.hash.slice(1))].flat(),
  ];
  return depth === 0
    ? values
    : values.flatMap((value) => [
        value,
        ...(URL.canParse(value, url)
          ? recovered(new URL(value, url).href, depth - 1)
          : []),
      ]);
};

/** A value as written and as URL and form decoding read it. */
const readings = (value: string): string[] => {
  const decode = (text: string) =>
    new URLSearchParams(`v=${text.replaceAll("&", "%26")}`).get("v") ?? text;
  return [value, decode(value.replaceAll("+", "%2B")), decode(value)];
};

it("keeps unrelated URL bytes and rewrites only leaking pieces", () => {
  const redactor = new SessionRedactor(["secret"]);
  const url =
    "https://app.test/api/projects/group%2Fproj/caf%E9/v1:batch;x=1/secret?q=a%20b&flag&k=secret&s=a;b#/route?x=1&access_token=secret";

  expect(redactor.url(url)).toBe(
    `https://app.test/api/projects/group%2Fproj/caf%E9/v1:batch;x=1/${MARKER}?q=a%20b&flag&k=${MARKER}&s=a;b#/route?x=1&access_token=${MARKER}`,
  );
  expect(redactor.url("https://app.test/plain?x=1")).toBe(
    "https://app.test/plain?x=1",
  );
  expect(redactor.fields).toBe(1);
});

it("finds declared values behind invalid UTF-8, nested and JSON encodings", () => {
  const redactor = new SessionRedactor([
    "abc�def",
    "acme",
    "ab+/cd==",
    "CORP\\alice",
    "José",
  ]);
  const urls = [
    "https://app.test/cb?token=abc%FFdef",
    "https://app.test/x?y=%61%63%6d%65%FF",
    "https://app.test/login?next=https%3A%2F%2Fapp.test%2Fcb%3Ft%3Dab%252B%252Fcd%253D%253D",
  ];
  for (const url of urls) {
    const redacted = redactor.url(url);
    expect(URL.canParse(redacted)).toBe(true);
    for (const value of recovered(redacted))
      for (const literal of ["abc�def", "acme", "ab+/cd=="])
        expect(value).not.toContain(literal);
  }
  for (const text of [
    '{"user":"CORP\\\\alice"}',
    '{"name":"Jos\\u00e9","token":"ab\\/cd+ef"}',
    "/login?next=%2Fcb%3Ft%3Dab%252B%252Fcd%253D%253D",
  ]) {
    const redacted = redactor.text(text);
    expect(redacted).not.toContain("CORP");
    expect(redacted).not.toContain("u00e9");
    expect(redacted).not.toContain("%252B");
  }
});

it("checks every decoding within three steps, whichever path reaches it first", () => {
  // Form decoding spells "pass \\\word", and so does percent decoding then
  // form decoding. A search that meets it two steps deep first must expand it
  // again from one step, where two JSON unescapes still spell the value.
  const redactor = new SessionRedactor(["pass \\word"]);

  expect(redactor.text("pass+%5C\\\\word")).toBe("");
  expect(redactor.fields).toBe(1);
});

it("rebuilds a value spelled with thousands of escapes whole", () => {
  // Decoding replaces thousands of escapes a slice at a time; a counter
  // never repeats, so a piece lost, repeated or misplaced breaks the value.
  const token = Array.from({ length: 2_000 }, (_, index) =>
    index.toString(16).padStart(3, "0"),
  ).join("");
  const escaped = (character: string) =>
    character.charCodeAt(0).toString(16).padStart(2, "0");
  const spellings = [
    [...token].map((character) => `\\u00${escaped(character)}`).join(""),
    [...token]
      .map((character, index) =>
        index % 2 === 0 ? `%${escaped(character)}` : character,
      )
      .join(""),
  ];
  for (const spelling of spellings) {
    expect(new SessionRedactor([token]).text(spelling)).toBe("");
    expect(new SessionRedactor([`${token}!`]).text(spelling)).toBe(spelling);
  }
});

it("undoes only JSON's own escapes", () => {
  const redactor = new SessionRedactor(["secret", "José"]);

  expect(redactor.text("se\\Ncret")).toBe("se\\Ncret");
  expect(redactor.text('{"n":"Jos\\u00E9"}')).not.toContain("u00E9");
});

it("redacts declared values as written before decoding erases their spelling", () => {
  const cases = [
    // A standard-base64 token in a query: a form reads its '+' as a space.
    [
      "ab+/cd==",
      "https://app.test/cb?sig=ab+/cd==&x=1&keep=a+b%2fc",
      `https://app.test/cb?sig=${MARKER}&x=1&keep=a+b%2fc`,
    ],
    [
      "tok+en",
      "https://app.test/cb?tok+en=1",
      `https://app.test/cb?${MARKER}=1`,
    ],
    // A lowercase escape and unreserved escapes, which decoding normalizes.
    [
      "abc%2fdef",
      "https://app.test/cb?t=abc%2fdef",
      `https://app.test/cb?t=${MARKER}`,
    ],
    [
      "%7Euser",
      "https://app.test/%7Euser/x?q=%7Euser#%7Euser",
      `https://app.test/${MARKER}/x?q=${MARKER}#${MARKER}`,
    ],
    [
      "tok%41",
      "https://app.test/k?v=tok%41&y=%41",
      `https://app.test/k?v=${MARKER}&y=%41`,
    ],
    // Beside escapes, a written '+' leaves no spelling of the value to
    // replace once a form decodes it, so the value is emptied.
    [
      "ab+/cd==",
      "https://app.test/cb?sig=ab+%2Fcd%3D%3D&x=1",
      "https://app.test/cb?sig=&x=1",
    ],
    [
      "ab+/cd",
      "https://app.test/cb?sig=ab+%252Fcd&x=1",
      "https://app.test/cb?sig=&x=1",
    ],
  ] as const;
  for (const [literal, url, expected] of cases) {
    const redactor = new SessionRedactor([literal]);

    const redacted = redactor.url(url);

    expect(redacted).toBe(expected);
    expect(URL.canParse(redacted)).toBe(true);
    for (const value of [...readings(redacted), ...recovered(redacted)])
      for (const reading of readings(literal))
        expect(value).not.toContain(reading);
    expect(redactor.fields).toBe(1);
  }
});

it("empties a piece whose re-encoding spells a declared value", () => {
  // Every marker's encoding spells "%5B", so "secret" is removed without one,
  // and the '[' it leaves would be encoded as "%5B".
  expect(
    new SessionRedactor(["%5B", "secret"]).url(
      "https://a.test/p?q=[secret&k=1",
    ),
  ).toBe("https://a.test/p?q=&k=1");
});

it("redacts a URL's host and port each on its own while it stays parseable", () => {
  const cases = [
    // A redacted host keeps a port that spells no declared value.
    [
      ["acme"],
      "https://acme.example.test:8443/a?b=1#c",
      "https://redacted.invalid:8443/a?b=1#c",
    ],
    // A port that spells one is emptied and the host is kept.
    [
      ["8443"],
      "https://app.example.test:8443/a?b=1",
      "https://app.example.test:/a?b=1",
    ],
    [
      ["acme", "8443"],
      "https://acme.example.test:8443/a",
      "https://redacted.invalid:/a",
    ],
    // An IPv6 host is bracketed, so its last group is not a port.
    [["8443"], "http://[::8443]/a", "http://redacted.invalid/a"],
    [
      ["::1"],
      "ws://[::1]:9000/live?x=1",
      "ws://redacted.invalid:9000/live?x=1",
    ],
    // A value spanning the host and the port fails the URL closed.
    [["test:8443"], "https://app.test:8443/a?b=1", "https://redacted.invalid/"],
  ] as const;
  for (const [literals, url, expected] of cases) {
    const redactor = new SessionRedactor(literals);

    const redacted = redactor.url(url);

    expect(redacted).toBe(expected);
    expect(URL.canParse(redacted)).toBe(true);
    expect(redactor.fields).toBe(1);
  }
});

it("matches declared values as spelled, not case-folded", () => {
  // Browsers report hosts lowercased and IDNs as punycode; a caller declares
  // the spelling the browser reports.
  expect(
    new SessionRedactor(["Acme-Corp"]).url("https://acme-corp.example/a"),
  ).toBe("https://acme-corp.example/a");
  expect(
    new SessionRedactor(["acme-corp"]).url("https://acme-corp.example/a"),
  ).toBe("https://redacted.invalid/a");
});

it("never keeps a declared value that the fallback or a marker spells", () => {
  for (const literal of ["red", "https", "t", "urn"]) {
    const redactor = new SessionRedactor([literal]);
    const redacted = redactor.url(`https://a${literal}.example/?q=${literal}`);
    expect(redacted).not.toContain(literal);
    expect(URL.canParse(redacted)).toBe(true);
    expect(redactor.fields).toBe(1);
  }
  // Every URL spells ":", so no placeholder qualifies.
  expect(new SessionRedactor([":"]).url("https://a.example/")).toBe("");
  // Every percent-encoded marker would spell "5D" ("%5D" closes the
  // bracket), so the empty one is chosen and the rest of the URL survives.
  expect(new SessionRedactor(["5D"]).url("https://a.example/p?q=5D")).toBe(
    "https://a.example/p?q=",
  );
});

it("covers every part of overlapping declared values", () => {
  const redactor = new SessionRedactor(["abcd1234", "1234wxyz", "ab", "bcd"]);

  expect(redactor.text("abcd1234wxyz")).toBe("[REDACTED:value-1]");
  expect(redactor.text("xabcdx")).toBe("x[REDACTED:value-3]x");
});

it("accepts a lone surrogate, which has no UTF-8 spelling", () => {
  const redactor = new SessionRedactor(["\ud800", "ok"]);

  // U+10000 is \ud800\udc00; its unmatched half is encoded as U+FFFD.
  expect(redactor.url("https://a.test/p/%F0%90%80%80?q=1")).toBe(
    `https://a.test/p/${MARKER}%EF%BF%BD?q=1`,
  );
  // A form would spell the literal as U+FFFD, which is not the literal.
  expect(redactor.text("\ud800 %EF%BF%BD")).toBe(
    "[REDACTED:value-1] %EF%BF%BD",
  );
  expect(redactor.text('{"v":"\\ud800"}')).toBe('{"v":"[REDACTED:value-1]"}');
});

it("derives query values exactly as URL parsing decodes them", () => {
  expect(
    declaredQueryValues(
      ["https://a.test/?token=abc%FFdef&other=x", "not a url"],
      ["token"],
    ),
  ).toEqual(["abc�def"]);
});

it("scales linearly with the number of declared values", () => {
  const values = Array.from(
    { length: 3_000 },
    (_, index) =>
      `sig${String(index).padStart(5, "0")}x${"0123456789abcdef".repeat(2)}`,
  );
  const started = performance.now();
  const redactor = new SessionRedactor(values);

  for (const value of values) {
    const redacted = redactor.url(
      `https://cdn.test/asset.png?X-Amz-Signature=${value}`,
    );
    expect(redacted).not.toContain(value);
    expect(redacted).toContain("REDACTED");
  }

  // The previous per-field spelling rebuild took ~18 s for 1,000 values.
  expect(performance.now() - started).toBeLessThan(10_000);
});

it("builds and scans in linear time when declared values nest", () => {
  const started = performance.now();
  const values = Array.from({ length: 2_000 }, (_, index) =>
    "a".repeat(index + 1),
  );
  const redactor = new SessionRedactor(values);

  expect(redactor.text("a".repeat(100_000))).not.toContain("aa");
  // Linear work takes well under a second here; quadratic marker selection
  // or suffix-chain visits (about 200 million) take a minute or exhaust memory.
  expect(performance.now() - started).toBeLessThan(10_000);
});
