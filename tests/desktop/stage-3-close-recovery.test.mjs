import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  verifyReceipt,
  verifyObservation,
  verifyRecovery,
  scenarios,
  incomplete,
} from "./stage-3-close-recovery-run.mjs";

test("W18b never treats absent or partial receipts as product acceptance", () => {
  for (const value of [
    null,
    {},
    { schema: 1, status: "passed" },
    { schema: 1, status: "partial", runs: [] },
  ])
    assert.throws(() => verifyReceipt(value));
  assert.equal(scenarios.length, 12);
  assert.equal(new Set(scenarios.map((row) => JSON.stringify(row))).size, 12);
  assert.equal(incomplete.length, 7);
});
test("a boolean or summary cannot substitute for raw worker/retirement observations", () => {
  for (const scenario of scenarios) {
    assert.throws(() => verifyObservation({ scenario, passed: true, saved: true }));
    assert.throws(() => verifyRecovery({ point: "before-publish", recovered: true }));
  }
});

const receiptPath = process.env.W18B_RECEIPT;
if (receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  for (const [index, run] of receipt.runs.entries()) {
    test(`executed row ${index + 1}: original observations and negative mutations`, () => {
      assert.equal(run.exit.code, 0, `Producer failed; inspect ${run.log}`);
      assert.equal(run.exit.signal, null);
      assert.equal(run.exit.timedOut, false);
      const verify = index < scenarios.length ? verifyObservation : verifyRecovery;
      verify(run.observation);
      const mutate = (change) => {
        const copy = structuredClone(run.observation);
        change(copy);
        assert.throws(() => verify(copy));
      };
      mutate((r) => {
        r.trace = [];
      });
      mutate((r) => {
        r.cleanup.workerJobs++;
      });
      if (index >= scenarios.length) {
        mutate((r) => {
          r.readback.bytes = "YQ==";
        });
        mutate((r) => {
          r.readback.meta.revision = "r_wrong";
        });
        mutate((r) => {
          r.restartTrace.push({ ticket: r.next.id });
        });
      } else {
        mutate((r) => {
          r.offers[0].deadline += 10001;
        });
        mutate((r) => {
          r.reports[0].owner.generation++;
        });
        mutate((r) => {
          r.installs++;
        });
        for (const name of ["pending-observed", "transition-settled", "worker-cleanup-observed"])
          mutate((r) => {
            r.events = r.events.filter((e) => e.event !== name);
          });
        if (run.observation.scenario.fault === "none") {
          mutate((r) => {
            r.reports[0].storage.state = "checkpoint-only";
          });
          mutate((r) => {
            r.publication.receipt.revision = "r_wrong";
          });
        } else {
          mutate((r) => {
            r.reports[0].storage.blocker = false;
          });
          mutate((r) => {
            r.publication = { disposition: "committed" };
          });
        }
      }
    });
  }
}
test(
  "independently validate executed W18b receipt and reject altered evidence",
  {
    skip: receiptPath ? false : "NOT RUN: set W18B_RECEIPT to the actual producer receipt.json",
  },
  async () => {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    verifyReceipt(receipt);
    assert.throws(() => verifyReceipt(receipt, { requireProduct: true }), /Incomplete W18b/);
    const mutate = (change) => {
      const copy = structuredClone(receipt);
      change(copy);
      assert.throws(() => verifyReceipt(copy));
    };
    mutate((r) => r.runs.pop());
    mutate((r) => r.runs.reverse());
    mutate((r) => {
      r.status = "passed";
    });
    mutate((r) => {
      r.incomplete = [];
    });
    mutate((r) => {
      r.identity.scope = "whole-product";
    });
    mutate((r) => {
      r.identity.sourceHashes = {};
    });
    for (let i = 0; i < receipt.runs.length; i++) {
      mutate((r) => {
        r.runs[i].exit.timedOut = true;
      });
      mutate((r) => {
        r.runs[i].exit.code = 1;
      });
      mutate((r) => {
        r.runs[i].exit.pid++;
      });
      mutate((r) => {
        r.runs[i].observation.trace = [];
      });
      if (i >= scenarios.length) {
        mutate((r) => {
          r.runs[i].observation.readback.bytes = "YQ==";
        });
        mutate((r) => {
          r.runs[i].observation.readback.meta.revision = "r_wrong";
        });
        mutate((r) => {
          r.runs[i].observation.restartTrace.push({ ticket: r.runs[i].observation.next.id });
        });
        continue;
      }
      mutate((r) => {
        r.runs[i].observation.offers[0].deadline += 10001;
      });
      mutate((r) => {
        r.runs[i].observation.reports[0].owner.generation++;
      });
      mutate((r) => {
        r.runs[i].observation.installs++;
      });
      for (const name of ["pending-observed", "transition-settled", "worker-cleanup-observed"]) {
        mutate((r) => {
          r.runs[i].observation.events = r.runs[i].observation.events.filter(
            (e) => e.event !== name,
          );
        });
      }
      if (receipt.runs[i].observation.scenario.fault === "none") {
        mutate((r) => {
          r.runs[i].observation.reports[0].storage.state = "checkpoint-only";
        });
        mutate((r) => {
          r.runs[i].observation.publication.receipt.revision = "r_wrong";
        });
      } else {
        mutate((r) => {
          r.runs[i].observation.reports[0].storage.blocker = false;
        });
        mutate((r) => {
          r.runs[i].observation.publication = { disposition: "committed" };
        });
      }
    }
  },
);
