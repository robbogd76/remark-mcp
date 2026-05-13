#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const axios = require("axios");

// axios doesn't expose insecureHTTPParser directly; inject it via a custom
// transport that wraps http.request so Node accepts non-compliant HTTP responses.
const insecureTransport = {
  request: (options, callback) => {
    options.insecureHTTPParser = true;
    return http.request(options, callback);
  },
};

const id = process.argv[2] ?? "acb96373-2c39-4021-b3b8-2512487df4ec";
const url = `http://10.11.99.1/download/${id}/pdf`;
const outFile = path.resolve(`${id}.pdf`);

console.log(`Fetching: ${url}`);

const t0 = Date.now();

axios
  .get(url, { responseType: "arraybuffer", timeout: 30000, transport: insecureTransport })
  .then((res) => {
    console.log(`Status: ${res.status} ${res.statusText} (${Date.now() - t0}ms)`);
    console.log("Headers:");
    for (const [k, v] of Object.entries(res.headers)) {
      console.log(`  ${k}: ${v}`);
    }

    const buf = Buffer.from(res.data);
    console.log(`Body: ${buf.length} bytes`);

    fs.writeFileSync(outFile, buf);
    console.log(`Saved to: ${outFile}`);
  })
  .catch((err) => {
    if (err.response) {
      console.error(`Error: ${err.response.status} ${err.response.statusText}`);
      console.error(`Error body: ${Buffer.from(err.response.data).toString()}`);
    } else {
      console.error(`Fetch failed: ${err.message}`);
    }
    process.exit(1);
  });
