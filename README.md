# PenlyDoc MCP server

Let an AI assistant send documents for e-signature with [PenlyDoc](https://penlydoc.com) and follow them:
"Send the lease to Mia Novak from the Residential lease template, rent 950 EUR", "Who still has to sign order 42?",
"Save the signed contract to ./signed".

It is a [Model Context Protocol](https://modelcontextprotocol.io) server that runs on your computer (stdio) and talks to the
PenlyDoc REST API with your organisation's API key. Works with any MCP client.

## Setup

1. Create an organisation at [penlydoc.com](https://penlydoc.com) (free) and copy an API key from **Console → Developers**.
2. Add the server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "penlydoc": {
      "command": "npx",
      "args": ["-y", "github:OrestKlymko/penlydoc-mcp"],
      "env": { "PENLY_API_KEY": "sk_…" }
    }
  }
}
```

Node.js 18.17 or newer is needed. `PENLY_URL` points the server at another PenlyDoc instance (default `https://penlydoc.com`).

Treat the API key like a password: it can send documents in your organisation's name. Give the assistant a key of its own,
so you can revoke it in the console without touching your other integrations.

## Tools

| Tool | What it does | Side effects |
|---|---|---|
| `get_organisation` | Which organisation the key belongs to, sending limit | none |
| `list_templates` | Templates with their roles and data keys | none |
| `send_from_template` | Create a document from a template; `send: true` e-mails the people | **e-mails real people** |
| `send_document` | Upload local PDFs or photos and create a document; boxes from `{{sig:1}}` tags or coordinates | **e-mails real people** when `send: true` |
| `list_documents` | Documents with status and who has signed; filter by status or your reference | none |
| `get_document` | One document: each person, opened, signed or declined, and when | none |
| `get_history` | Hash-chained history with times and IP addresses | none |
| `send_draft` | Send a draft | **e-mails real people** |
| `send_reminder` | Remind everyone whose turn it is | **e-mails real people** |
| `cancel_document` | Void a document that is still being signed | **cannot be undone** |
| `create_signing_link` | One-hour link for an embedded signer | the link signs as that person |
| `download_signed_pdf` | Save the sealed PDF of a completed document to a file | writes a local file (never overwrites) |
| `verify_pdf` | Check a signed PDF: seal intact, who signed | none, no key needed |

The server tells the assistant to confirm people, e-mail addresses and documents with you before anything is sent.
Most MCP clients also ask you before each tool call; keep that on for the tools that e-mail people.

## Learn more

- [Developer guide](https://penlydoc.com/docs) and [embedding guide](https://penlydoc.com/docs/embed)
- [Examples in Node.js, Python, PHP and React](https://github.com/OrestKlymko/penlydoc-examples)

MIT licensed.
