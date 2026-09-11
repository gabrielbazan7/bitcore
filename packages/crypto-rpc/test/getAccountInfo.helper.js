import { expect } from 'chai';

// Structural assertions for a client.getAccountInfo() result, shared by the real integration tests in
// sol.js and spl.js that hit a local validator or devnet. Keeping this in one place means both suites are
// checking the same result shape, so a change to getAccountInfo's return value only needs to be taught to
// one assertion, not two copy-pasted ones. This is a plain function with no describe/it of its own, so
// importing it has no side effects on either file's own test run.
export const assertAccountInfoShape = result => {
  expect(result).to.be.an('object').that.is.not.null;
  expect(result).to.have.all.keys('lamports', 'atas', 'space');
  expect(result).to.have.property('lamports').that.is.a('number').greaterThanOrEqual(0);
  expect(result).to.have.property('atas').that.is.an('array');
  if (result.space !== undefined) {
    expect(result).to.have.property('space').that.is.a('number').greaterThanOrEqual(0);
  }
  expect(() => JSON.stringify(result)).not.to.throw();
  for (const ata of result.atas) {
    expect(ata).to.be.an('object');
    expect(ata).to.have.property('mint').that.is.a('string');
    expect(ata).to.have.property('pubkey').that.is.a('string');
    expect(ata).to.have.property('state').that.is.a('string');
    expect(ata).to.have.property('atas').that.is.an('array');
  }
};

// Records every call SolRpc/SplRpc makes through `this.rpc.getAccountInfo(...)`, along with the raw
// response the real validator sent back for each one. sinon can't stub this directly - the kit RPC
// client is a Proxy with no own properties, so both sinon.stub and a plain property assignment reject
// it ("Attempted to wrap undefined property" / "trap returned falsish"). Swapping in a Proxy that only
// intercepts the one method under test, and lets everything else through untouched, works around that.
//
// This exists to catch a regression where a dataSlice option gets dropped from one of these calls:
// asserting solRpc.getAccountInfo()/getTokenAccountsByOwner() still resolve correctly wouldn't catch
// that, since removing dataSlice doesn't change what those methods return - the account data payload
// they're now silently paying to fetch is simply unused.
export function recordGetAccountInfoCalls(rpcClient) {
  const realRpc = rpcClient.rpc;
  const calls = [];
  rpcClient.rpc = new Proxy(realRpc, {
    get(target, prop, _receiver) {
      if (prop !== 'getAccountInfo') {
        return Reflect.get(target, prop, target);
      }
      return (...args) => ({
        send: async (...sendArgs) => {
          const response = await target.getAccountInfo(...args).send(...sendArgs);
          calls.push({ args, response });
          return response;
        }
      });
    }
  });
  return {
    calls,
    restore: () => { rpcClient.rpc = realRpc; }
  };
}
