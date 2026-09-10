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
