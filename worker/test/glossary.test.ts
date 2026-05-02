import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Structural assertions on the rendered /cfb/glossary HTML. We
// deliberately don't snapshot the full body — Hono's HTML emitter
// sometimes shifts attribute order, and the EJS source is changing
// during the port. Instead, pin the things that *matter*: status,
// content-type, that all expected letter sections rendered, that a
// known term-and-definition pair survived the JSON load + sort +
// render path, and that the asset/chrome wiring is intact.

const EXPECTED_LETTERS = ["A", "D", "E", "H", "L", "M", "O", "P", "R", "S", "T", "W"];

describe("/cfb/glossary", () => {
  it("returns a 200 HTML response", async () => {
    const res = await SELF.fetch("http://localhost/cfb/glossary");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("renders every letter section that has entries in glossary.json", async () => {
    const res = await SELF.fetch("http://localhost/cfb/glossary");
    const body = await res.text();
    for (const letter of EXPECTED_LETTERS) {
      expect(body).toContain(`id="glossary-section-${letter}"`);
    }
  });

  it("alphabetizes terms within a section (E: Early down comes before Expected)", async () => {
    const res = await SELF.fetch("http://localhost/cfb/glossary");
    const body = await res.text();
    const earlyIdx = body.indexOf("Early down");
    const expectedIdx = body.indexOf("Expected points added");
    expect(earlyIdx).toBeGreaterThan(-1);
    expect(expectedIdx).toBeGreaterThan(-1);
    expect(earlyIdx).toBeLessThan(expectedIdx);
  });

  it("preserves HTML in definitions (the `<%- %>` unescaped path)", async () => {
    // OL Line Yards definition contains a real <table> in the JSON
    // source; if the port escaped it like `<%= %>` does, this would
    // be `&lt;table&gt;` instead.
    const res = await SELF.fetch("http://localhost/cfb/glossary");
    const body = await res.text();
    expect(body).toContain("OL Line Yards");
    expect(body).toMatch(/<table[^>]*>[\s\S]*Yards Gained[\s\S]*<\/table>/);
  });

  it("links the source URL when present, omits the link when source is empty", async () => {
    const res = await SELF.fetch("http://localhost/cfb/glossary");
    const body = await res.text();
    // EPA has a non-empty source.
    expect(body).toMatch(
      /<a[^>]+href="https:\/\/www\.opensourcefootball\.com[^"]*"[^>]*>Expected points added \(EPA\)<\/a>/,
    );
    // "Early down" has source: "" — should render as plain <dt>, not <a>.
    expect(body).toMatch(/<dt[^>]*>Early down<\/dt>/);
  });

  it("includes the shared layout chrome (nav, footer, plausible)", async () => {
    const res = await SELF.fetch("http://localhost/cfb/glossary");
    const body = await res.text();
    expect(body).toContain('href="/cfb/glossary"'); // nav has self-link
    expect(body).toContain("blog-footer"); // footer
    expect(body).toContain("plausible.io/js/script.js"); // analytics
  });
});
