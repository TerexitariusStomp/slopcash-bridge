// The pipeline: claim → evidence → AI verdict → PayPal payout → receipt.

import { adjudicate } from "./adjudicator";
import { crosscheck, gatherCommitEvidence } from "./evidence";
import { fetchOpLog, verifyChain } from "./oplog";
import { refreshBatch, sendPayout } from "./payouts";
import { getBounty, getRecord, putRecord } from "./store";
import { writebackReceipt } from "./writeback";
import type {
  Bounty,
  Env,
  PayoutReceipt,
  ReviewRecord,
  ShipClaim,
} from "./types";

function receiverFor(claim: ShipClaim, bounty: Bounty | null, actor: string): string | null {
  if (bounty?.recipients?.[actor]) return bounty.recipients[actor];
  if (bounty?.receiver_email) return bounty.receiver_email;
  if (claim.paypal_email) return claim.paypal_email;
  return null;
}

/**
 * Review one op-log entry end to end. Returns the persisted record;
 * throws only on malformed requests (unknown repo / missing seq).
 */
export async function runReview(
  env: Env,
  repo: string,
  seq: number,
  opts: { force?: boolean } = {}
): Promise<ReviewRecord> {
  const id = `${repo}:${seq}`;
  if (!opts.force) {
    const existing = await getRecord(env, repo, seq);
    if (existing) return existing;
  }

  // A forced re-review refreshes the prior batch's settlement state rather
  // than re-POSTing — PayPal rejects a second send under the same
  // sender_batch_id, and one claim = one payout regardless.
  const prior = opts.force ? await getRecord(env, repo, seq) : null;

  const entries = await fetchOpLog(env.FORGE_BASE, repo);
  const entry = entries.find((e) => e.seq === seq);
  if (!entry) throw new Error(`no op-log entry seq=${seq} in ${repo}`);
  if (entry.kind !== "ship" || entry.payload?.ship !== true) {
    throw new Error(`entry ${seq} is not an accepted ship claim (kind=${entry.kind})`);
  }

  const claim = entry.payload as unknown as ShipClaim;
  const [chain, bounty] = await Promise.all([verifyChain(entries), getBounty(env, repo)]);

  // Recompute each claimed commit's diff independently of the forge verdict.
  const commits = await Promise.all(
    (claim.commits ?? []).map((sha) =>
      gatherCommitEvidence(env, repo, sha, bounty?.upstream)
    )
  );
  const check = crosscheck(claim, commits);

  const adjudication = await adjudicate(env, {
    repo,
    entry,
    chain,
    bounty,
    commits,
    check,
  });

  // Money moves only on: model says accept + confidence floor + intact chain.
  const minConfidence = Number(env.MIN_CONFIDENCE ?? "0.6");
  const accepted =
    adjudication.verdict === "accept" &&
    adjudication.confidence >= minConfidence &&
    chain.valid;

  let payout: PayoutReceipt | null = null;
  if (accepted) {
    const receiver = receiverFor(claim, bounty, entry.actor);
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      payout = { attempted: false, skipped_reason: "PAYPAL_CLIENT_ID/SECRET not set", sandbox: true };
    } else if (!receiver) {
      payout = {
        attempted: false,
        skipped_reason: "no recipient — seed a bounty for this repo or set claim.paypal_email",
        sandbox: true,
      };
    } else if (prior?.payout?.batch_id) {
      payout = await refreshBatch(env, prior.payout);
    } else {
      payout = await sendPayout(env, {
        repo,
        seq,
        receiver,
        amount: bounty?.amount ?? "1.00",
        currency: bounty?.currency ?? "USD",
        note: `Slop.cash bounty for ${repo} ship claim #${seq}`,
      });
    }
  }

  // Receipt back to the forge as a signed commit status (bidirectional audit).
  const firstSha = claim.commits?.[0];
  const writeback = firstSha
    ? await writebackReceipt(env, {
        repo,
        sha: firstSha,
        accepted,
        description: payout?.batch_id
          ? `PayPal Payouts batch ${payout.batch_id} (${payout.transaction_status ?? payout.batch_status ?? "sent"})`
          : `adjudicated ${adjudication.verdict} (confidence ${adjudication.confidence})`,
        claimId: id,
      })
    : { attempted: false, skipped_reason: "no commits in claim" };

  const record: ReviewRecord = {
    id,
    repo,
    seq,
    status: adjudication.error
      ? "error"
      : !accepted
        ? "rejected"
        : payout?.batch_id
          ? "accepted_paid"
          : "accepted_unpaid",
    claim: entry,
    chain,
    commits,
    crosscheck: check,
    bounty,
    adjudication,
    payout,
    writeback,
    reviewed_at: Date.now(),
  };
  await putRecord(env, record);
  return record;
}

/** Review every unprocessed ship claim in a repo (cron + bulk /review). */
export async function reviewOutstanding(
  env: Env,
  repo: string,
  limit = 5
): Promise<ReviewRecord[]> {
  const entries = await fetchOpLog(env.FORGE_BASE, repo);
  const shipEntries = entries.filter((e) => e.kind === "ship" && e.payload?.ship === true);
  const out: ReviewRecord[] = [];
  for (const entry of shipEntries.slice(-limit)) {
    if (await getRecord(env, repo, entry.seq)) continue;
    out.push(await runReview(env, repo, entry.seq));
  }
  return out;
}
