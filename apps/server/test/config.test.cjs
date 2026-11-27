const { test } = require("node:test");
const assert = require("node:assert/strict");
const { trustProxy } = require("../dist/config");

test("TRUST_PROXY is off unless explicitly configured", () => {
  assert.equal(trustProxy(undefined), false);
  assert.equal(trustProxy(""), false);
  assert.equal(trustProxy(" false "), false);
});

test("TRUST_PROXY accepts hop counts and proxy addresses", () => {
  assert.equal(trustProxy("1"), 1);
  assert.deepEqual(trustProxy("172.18.0.0/16"), ["172.18.0.0/16"]);
  assert.deepEqual(trustProxy("loopback, 10.0.0.2, fd00::/8"), [
    "loopback",
    "10.0.0.2",
    "fd00::/8",
  ]);
});

test("TRUST_PROXY refuses trusting every peer and malformed values", () => {
  for (const value of [
    "true",
    "0",
    "11",
    "proxy",
    "172.18.0.0/33",
    "fd00::/129",
    "10.0.0.1/8/1",
    "1.2.3",
    ",",
    "10.0.0.0/x",
  ]) {
    assert.throws(() => trustProxy(value), /TRUST_PROXY/, value);
  }
});

test("SEARCH_RETRY_MINUTES defaults to one hour and is bounded", () => {
  const { searchRetrySeconds } = require("../dist/config");
  assert.equal(searchRetrySeconds(undefined), 3600);
  assert.equal(searchRetrySeconds(" "), 3600);
  assert.equal(searchRetrySeconds("15"), 900);
  assert.equal(searchRetrySeconds("360"), 21600);
  for (const value of ["14", "10081", "1.5", "-60", "hour", "60m"]) {
    assert.throws(() => searchRetrySeconds(value), /SEARCH_RETRY_MINUTES/, value);
  }
});
test("the reported version is the package version", () => {
  const { appVersion } = require("../dist/config");
  assert.equal(appVersion, require("../package.json").version);
  assert.match(appVersion, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
});

test("the Hub budget defaults to 20 calls a minute and rejects nonsense", () => {
  const { hubBudget, hubTimings } = require("../dist/config");
  // The lock outlasts the call and the others wait just past it, whatever the timeout.
  assert.deepEqual(hubTimings(undefined), { timeoutMs: 20000, lockSeconds: 25, waitMs: 21000 });
  assert.deepEqual(hubTimings(""), { timeoutMs: 20000, lockSeconds: 25, waitMs: 21000 });
  assert.deepEqual(hubTimings("10"), { timeoutMs: 10000, lockSeconds: 15, waitMs: 11000 });
  assert.deepEqual(hubTimings("20"), { timeoutMs: 20000, lockSeconds: 25, waitMs: 21000 });
  for (const bad of ["0", "121", "2.5", "ten"]) {
    assert.throws(() => hubTimings(bad), /HUB_TIMEOUT_SECONDS/);
  }
  assert.equal(hubBudget(undefined), 20);
  assert.equal(hubBudget("60"), 60);
  for (const value of ["0", "1001", "1.5", "lots"]) {
    assert.throws(() => hubBudget(value), /HUB_REQUESTS_PER_MINUTE/);
  }
});
