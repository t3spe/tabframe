# Tabframe's documents

In reading order; the repository README is the front door, this is the index.

| Document | Read it for |
|---|---|
| [`design.md`](design.md) | the design record: decisions D1–D20, the system, the wire, hosting, security, tooling; §17 is the change history, read with the body |
| [`walkthrough.md`](walkthrough.md) | the page's contract: every screen, state, and control, checked by `e2e/walkthrough.e2e.ts` |
| [`../packages/sdk-as/README.md`](../packages/sdk-as/README.md) | how to write a program: the API, the limits, how a task is scheduled; the page's guide is its first half |
| [`../programs/README.md`](../programs/README.md) | the three programs that ship, each with a README of its own |
| [`feasibility-transformer.md`](feasibility-transformer.md) | a worked program: the small transformer on the cores, with the measured numbers |
| [`runbook.md`](runbook.md) | operating the deployed machine: what runs, the mise tasks, deploy and rollback, `/health`, incidents |
| [`implementation/`](implementation/README.md) | how it was built, one note per work package; historical, not kept current |

One vocabulary throughout: a **core** is any worker; a **cloud core** is the MicroVM kind; a **node**
is a joined core in the ledger; a **host** is a browser tab (design §16).
