import assert from "node:assert/strict"
import { parseOpenAIUsage, type BalanceDetail } from "../src/balance-providers"

const nowMs = 1_700_000_000_000
const nowSeconds = nowMs / 1000

function getDetails(raw: unknown): BalanceDetail[] {
  return parseOpenAIUsage(raw, nowMs)[0]?.details ?? []
}

function findDetail(details: BalanceDetail[], key: BalanceDetail["key"], windowSeconds?: number): BalanceDetail | undefined {
  return details.find((detail) => detail.key === key && detail.windowSeconds === windowSeconds)
}

const managedDetails = getDetails({
  plan_type: "team",
  rate_limit: null,
  credits: { balance: null, unlimited: false },
  spend_control: {
    individual_limit: {
      limit: "1000",
      used: "36.7974872589",
      remaining: "963.2025127411",
      used_percent: 4,
      remaining_percent: 96,
      reset_at: nowSeconds + 3600,
    },
  },
})
assert.equal(findDetail(managedDetails, "used")?.value, "4%")
assert.equal(findDetail(managedDetails, "remaining")?.value, "96%")
assert.equal(findDetail(managedDetails, "credits")?.value, "963.2 / 1000")
assert.equal(findDetail(managedDetails, "reset")?.value, "3600")

const multiWindow = parseOpenAIUsage({
  rate_limit: {
    secondary_window: {
      used_percent: 90,
      limit_window_seconds: 604800,
      reset_at: nowSeconds + 7200,
    },
    primary_window: {
      used_percent: 15,
      limit_window_seconds: 18000,
      reset_after_seconds: 1800,
    },
  },
}, nowMs)[0]
assert.equal(multiWindow.display, "Codex 10%")
const multiDetails = multiWindow.details ?? []
assert.deepEqual(
  multiDetails.filter((detail) => detail.key === "remaining").map((detail) => [detail.windowSeconds, detail.value]),
  [[18000, "85%"], [604800, "10%"]],
)
assert.equal(findDetail(multiDetails, "reset", 18000)?.value, "1800")
assert.equal(findDetail(multiDetails, "reset", 604800)?.value, "7200")

assert.throws(() => parseOpenAIUsage({ rate_limit: null, credits: { balance: null } }, nowMs), /EMPTY/)

console.log("Codex balance shape tests passed")
