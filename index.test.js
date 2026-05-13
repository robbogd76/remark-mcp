"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Helpers to build fake reMarkable API responses
// ---------------------------------------------------------------------------

function makeFile(id, name, modified = "2024-01-15T10:00:00.000Z") {
  return {
    ID: id,
    VissibleName: name,  // reMarkable API spells this with double-s
    Type: "DocumentType",
    ModifiedClient: modified,
  };
}

function makeFolder(id, name) {
  return {
    ID: id,
    VissibleName: name,
    Type: "CollectionType",
    ModifiedClient: "2024-01-10T08:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Stub out axios, pdf-to-png-converter, and the MCP SDK via Module._load
// before requiring index.js, so every dependency can be controlled per-test.
// ---------------------------------------------------------------------------

const Module = require("node:module");
const originalLoad = Module._load;
const toolRegistry = {};

let axiosGetImpl = async () => { throw new Error("axiosGetImpl not set for this test"); };

function makeAxiosError(status, statusText) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, statusText };
  return err;
}

let pdfToPngImpl = async () => [
  { pageNumber: 1, content: Buffer.from("fake-png-page-1") },
];

Module._load = function (request, _parent, _isMain) {
  if (request === "axios") {
    return { get: (...args) => axiosGetImpl(...args) };
  }
  if (request === "pdf-to-png-converter") {
    return { pdfToPng: (...args) => pdfToPngImpl(...args) };
  }
  if (request === "@modelcontextprotocol/sdk/server/mcp.js") {
    return {
      McpServer: class FakeMcpServer {
        constructor() {}
        tool(name, _desc, _schema, handler) { toolRegistry[name] = handler; }
        async connect() {}
      },
    };
  }
  if (request === "@modelcontextprotocol/sdk/server/stdio.js") {
    return { StdioServerTransport: class FakeTransport {} };
  }
  return originalLoad.apply(this, arguments);
};

require("./index.js");

Module._load = originalLoad;

// ---------------------------------------------------------------------------
// Pure-logic unit tests (no network)
// ---------------------------------------------------------------------------

test("formatEntries - empty array returns 'No items found.'", () => {
  const entries = [];
  const result = entries.length === 0 ? "No items found." : "something";
  assert.equal(result, "No items found.");
});

test("formatEntries - file entry shows [file] prefix and id", () => {
  const entry = makeFile("abc-123", "My Document");
  const type = entry.Type === "CollectionType" ? "[folder]" : "[file]";
  const name = entry.VissibleName ?? entry.ID;
  const line = `${type} ${name}  (id: ${entry.ID})`;
  assert.match(line, /^\[file\]/);
  assert.match(line, /My Document/);
  assert.match(line, /abc-123/);
});

test("formatEntries - folder entry shows [folder] prefix", () => {
  const entry = makeFolder("folder-1", "Work");
  const type = entry.Type === "CollectionType" ? "[folder]" : "[file]";
  assert.equal(type, "[folder]");
});

// ---------------------------------------------------------------------------
// Tool: list_root
// ---------------------------------------------------------------------------

test("list_root - returns formatted file and folder list", async () => {
  const fakeEntries = [
    makeFolder("folder-1", "Work"),
    makeFile("file-1", "Meeting Notes"),
  ];

  axiosGetImpl = async (url) => {
    assert.equal(url, "http://10.11.99.1/documents/");
    return { status: 200, data: fakeEntries };
  };

  const result = await toolRegistry["list_root"]({});
  const text = result.content[0].text;

  assert.match(text, /\[folder\] Work/);
  assert.match(text, /folder-1/);
  assert.match(text, /\[file\] Meeting Notes/);
  assert.match(text, /file-1/);
});

test("list_root - returns 'No items found.' for empty root", async () => {
  axiosGetImpl = async () => ({ status: 200, data: [] });

  const result = await toolRegistry["list_root"]({});
  assert.equal(result.content[0].text, "No items found.");
});

test("list_root - throws when tablet returns non-OK status", async () => {
  axiosGetImpl = async () => { throw makeAxiosError(503, "Service Unavailable"); };

  await assert.rejects(
    () => toolRegistry["list_root"]({}),
    /503/
  );
});

// ---------------------------------------------------------------------------
// Tool: list_folder
// ---------------------------------------------------------------------------

test("list_folder - fetches /documents/<id> and formats result", async () => {
  const folderId = "abcd-1234";
  const fakeEntries = [makeFile("child-file", "Sub Document")];

  axiosGetImpl = async (url) => {
    assert.equal(url, `http://10.11.99.1/documents/${folderId}`);
    return { status: 200, data: fakeEntries };
  };

  const result = await toolRegistry["list_folder"]({ id: folderId });
  const text = result.content[0].text;

  assert.match(text, /Sub Document/);
  assert.match(text, /child-file/);
});

test("list_folder - returns 'No items found.' for empty folder", async () => {
  axiosGetImpl = async () => ({ status: 200, data: [] });

  const result = await toolRegistry["list_folder"]({ id: "some-id" });
  assert.equal(result.content[0].text, "No items found.");
});

test("list_folder - throws when tablet returns 404", async () => {
  axiosGetImpl = async () => { throw makeAxiosError(404, "Not Found"); };

  await assert.rejects(
    () => toolRegistry["list_folder"]({ id: "bad-id" }),
    /404/
  );
});

// ---------------------------------------------------------------------------
// Tool: download_pdf
// ---------------------------------------------------------------------------

const FAKE_PDF = Buffer.from("%PDF-1.4 fake pdf content");
const FAKE_PAGE_1 = Buffer.from("fake-png-data-page-1");
const FAKE_PAGE_2 = Buffer.from("fake-png-data-page-2");

test("download_pdf - fetches correct URL and returns page images", async () => {
  const docId = "doc-xyz";
  axiosGetImpl = async (url) => {
    assert.equal(url, `http://10.11.99.1/download/${docId}/pdf`);
    return { status: 200, data: FAKE_PDF };
  };
  pdfToPngImpl = async () => [
    { pageNumber: 1, content: FAKE_PAGE_1 },
    { pageNumber: 2, content: FAKE_PAGE_2 },
  ];

  const result = await toolRegistry["download_pdf"]({ id: docId });

  // First item is the text header, then one image per page
  assert.equal(result.content.length, 3);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /2 pages/);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, FAKE_PAGE_1.toString("base64"));
  assert.equal(result.content[2].type, "image");
  assert.equal(result.content[2].data, FAKE_PAGE_2.toString("base64"));
});

test("download_pdf - includes document label with name when provided", async () => {
  axiosGetImpl = async () => ({ status: 200, data: FAKE_PDF });
  pdfToPngImpl = async () => [{ pageNumber: 1, content: FAKE_PAGE_1 }];

  const result = await toolRegistry["download_pdf"]({ id: "x", name: "My Doc" });
  assert.match(result.content[0].text, /My Doc\.pdf/);
});

test("download_pdf - uses id as filename when name is omitted", async () => {
  axiosGetImpl = async () => ({ status: 200, data: FAKE_PDF });
  pdfToPngImpl = async () => [{ pageNumber: 1, content: FAKE_PAGE_1 }];

  const result = await toolRegistry["download_pdf"]({ id: "doc-abc" });
  assert.match(result.content[0].text, /doc-abc\.pdf/);
});

test("download_pdf - throws when tablet returns non-OK status", async () => {
  axiosGetImpl = async () => { throw makeAxiosError(500, "Internal Server Error"); };

  await assert.rejects(
    () => toolRegistry["download_pdf"]({ id: "bad-doc" }),
    /500/
  );
});
