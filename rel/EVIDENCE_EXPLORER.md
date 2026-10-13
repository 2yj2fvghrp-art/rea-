# REL Evidence Explorer

**Go beyond the teaching animation.** This command reads an existing, saved REA JavaScript application Evidence record. It does not run an unknown program or download anything.

Run real analysis first, on REL's owned lab:

    npm ci
    npm run build:cached
    OUT="$(mktemp -d)"
    node rel.mjs demo --run --out "$OUT"

Read a real saved graph, filtering by source file:

    node rel/evidence-explorer.mjs "$OUT/evidence.json"
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --find search.mjs --limit 20
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --json
    node rel/evidence-explorer.mjs "$OUT/evidence.json" --dot > "$OUT/relationships.dot"

DOT is Graphviz input, not a browser UI. If Graphviz is installed, render with:

    dot -Tsvg "$OUT/relationships.dot" -o "$OUT/relationships.svg"

**What is real:** saved application graph edges, identifiers, any analyzer-returned source locations, confidence and relationship types.

**What is not proven:** runtime execution, semantic completeness, that every provider works, or digest validity independently of REA. Missing locations are displayed as not provided. Invalid or mismatched analyzer records fail closed.

The reader caps a JSON file at 64 MiB and limits displayed relationships to 40 per invocation; filtering does not mutate the underlying Evidence. Only one analysis family is supported by this companion tool today. The original REA engine remains unchanged.

Run regression tests:

    node --test rel/evidence-explorer.test.mjs

**Next:** expand provider-specific viewers after each one has real artifacts, tests and explainable provenance.
