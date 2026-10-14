import { describe, expect, it } from "vitest";

import { servedOverHttps } from "./HopperDownload.js";

describe("servedOverHttps", () => {
  it("admits a final HTTPS response URL", () => {
    expect(
      servedOverHttps(
        "https://www.hopperapp.com/downloader/public/Hopper-6.4.2-Linux-demo.deb",
      ),
    ).toBe(true);
  });

  it("refuses a redirect that downgraded to plain HTTP or another scheme", () => {
    for (const url of [
      "http://www.hopperapp.com/downloader/public/Hopper.deb",
      "ftp://example.test/Hopper.deb",
      "",
      "not a url",
    ])
      expect(servedOverHttps(url)).toBe(false);
  });
});
