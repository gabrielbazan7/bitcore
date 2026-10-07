'use strict';

import sinon from 'sinon';
import * as chai from 'chai';
import BWS from '@bitpay-labs/bitcore-wallet-service';
import { Defaults as BwsDefaults } from '@bitpay-labs/bitcore-wallet-service/ts_build/src/lib/common/defaults';
import {
  TssKeyGen as BwsTssKeyGen,
  TssSign as BwsTssSign
} from '@bitpay-labs/bitcore-wallet-service/ts_build/src/lib/tss';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ECIES } from '@bitpay-labs/bitcore-tss';
import { Request } from '../src/lib/request';
import { BitcoreLib, Deriver, Transactions, ethers } from '@bitpay-labs/crypto-wallet-core';
import { TssKeyGen, TssKey, type TssKeyRoster } from '../src/lib/tsskey';
import { TssSign } from '../src/lib/tsssign';
import { Constants, Utils } from '../src/lib/common';
import { Errors } from '../src/lib/errors';
import type { TssKeyMember } from '../src/lib/api';
import log from '../src/lib/log';
import Client, { type Credentials } from '../src';
import {
  helpers,
  blockchainExplorerMock
} from './helpers';
import type { IErrorSpec } from '../src/lib/errors/spec';

const should = chai.should();
const datadir = path.join(__dirname, 'data');
const Key = Client.Key;

describe('TSS', function() {
  this.timeout(Math.max(this['_timeout'], 10000));

  const happyPath = testName => `\u263A HAPPY PATH - ${testName}`;

  let db;
  let storage;
  let dbConnection;
  let app;
  const sandbox = sinon.createSandbox();
  const chain = 'ETH';
  const network = 'livenet';
  const m = 2;
  const n = 3;
  const derivationPath = Deriver.pathFor(chain, network);

  before(function(done) {
    helpers.newDb(null, (err, database, connection) => {
      dbConnection = connection;
      db = database;
      storage = new BWS.Storage({ db });
      BWS.Storage.createIndexes(db);

      const expressApp = new BWS.ExpressApp();
      expressApp.start(
        {
          ignoreRateLimiter: true,
          storage: storage,
          blockchainExplorer: blockchainExplorerMock,
          disableLogs: true,
          doNotCheckV8: true
        },
        () => {
          app = expressApp.app;

          if (!process.env.BWC_SHOW_LOGS) {
            sandbox.stub(log, 'warn');
            sandbox.stub(log, 'info');
            sandbox.stub(log, 'error');
          }
          done();
        }
      );
    });
  });

  beforeEach(function() {
    sandbox.stub(BwsTssKeyGen, 'getMessagesForParty').callsFake(async function(params) {
      params.maxWaitTimeSec = 1;
      return (BwsTssKeyGen.getMessagesForParty as any).wrappedMethod.call(this, params);
    });
    sandbox.stub(BwsTssSign, 'getMessagesForParty').callsFake(async function(params) {
      params.maxWaitTimeSec = 1;
      return (BwsTssSign.getMessagesForParty as any).wrappedMethod.call(this, params);
    });
  });

  after(function(done) {
    dbConnection.close(done);
  });

  afterEach(function() {
    sandbox.restore();
  });

  function loadTssKey(file: string): TssKey {
    const objToBuf = (_key, value) => value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value;
    return new TssKey(JSON.parse(fs.readFileSync(`${datadir}/${file}`).toString(), objToBuf).tss);
  }

  let sharedTssWallet: Promise<{ tssKeys: TssKey[]; credentials: Credentials[]; clients: Client[] }>;

  function ensureSharedTssWallet() {
    sharedTssWallet ??= (async () => {
      const tssKeys = ['tss-party0.json', 'tss-party1.json', 'tss-party2.json'].map(loadTssKey);
      const credentials = tssKeys.map(tssKey => tssKey.createCredentials(null, { chain, network: 'testnet', account: 0 }));
      await storage.storeTssKeyGenSession({
        doc: {
          id: tssKeys[0].metadata.id,
          n: tssKeys.length,
          participants: credentials.map(c => c.copayerId),
          rounds: [credentials.map((c, partyId) => ({ fromPartyId: partyId, messages: { partyId, publicKey: c.requestPubKey } }))],
          sharedPublicKey: tssKeys[0].keychain.commonKeyChain,
        }
      });
      const clients = credentials.map(c => {
        const client = helpers.newClient(app);
        client.fromObj(c.toObj());
        return client;
      });
      const { secret } = await clients[0].createWallet('tss wallet', 'party 0', tssKeys[0].metadata.m, tssKeys[0].metadata.n, {
        chain: chain.toLowerCase(),
        network: 'testnet',
        tssKeyId: tssKeys[0].metadata.id
      });
      for (const [partyId, client] of clients.entries()) {
        if (partyId > 0) {
          await client.joinWallet(secret, `party ${partyId}`, { chain: chain.toLowerCase() });
        }
      }
      for (const client of clients) {
        await client.openWallet({ forceOpen: true });
      }
      return { tssKeys, credentials, clients };
    })();
    return sharedTssWallet;
  }

  async function signWithTss(signers: Array<{ tssKey: TssKey; credentials: Credentials }>, messageHash: Buffer, id: string) {
    const sessions = signers.map(({ tssKey, credentials }) => new TssSign({ baseUrl: '/bws/api', request: request(app), credentials, tssKey }));
    for (const session of sessions) {
      await session.start({ id, messageHash, derivationPath: 'm/0/0' });
    }
    const signatures = sessions.map(session => new Promise((resolve, reject) => {
      session.once('signature', resolve);
      session.once('error', reject);
    }));
    for (const session of sessions) {
      session.subscribe({ timeout: 10 });
    }
    try {
      const [signature] = await Promise.all(signatures);
      return signature;
    } finally {
      for (const session of sessions) {
        session.unsubscribe();
      }
    }
  }

  describe('Key Generation', function() {
    const party0Key = new Key({ seedType: 'new' });
    const party1Key = new Key({ seedType: 'new' });
    const party2Key = new Key({ seedType: 'new' });
    let tss0: TssKeyGen;
    let tss1: TssKeyGen;
    let tss2: TssKeyGen;
    let joinCode1: string;
    let joinCode2: string;

    afterEach(function() {
      tss0?.unsubscribe();
      tss1?.unsubscribe();
      tss2?.unsubscribe();
    });

    it(happyPath('should instantiate a new TssKeyGen class'), function() {
      tss0 = new TssKeyGen({
        chain,
        network,
        baseUrl: '/bws/api',
        request: request(app),
        key: party0Key
      });
      should.exist(tss0);
      tss0.should.be.instanceOf(TssKeyGen);
    });

    it(happyPath('should start a new keygen session'), async function() {
      const result = await tss0.newKey({ m, n });
      should.exist(result);
      result.should.equal(tss0);
      tss0.id.should.be.a('string');
      const chainXpriv = BitcoreLib.HDPrivateKey.fromString(party0Key.get().xPrivKey).deriveChild(derivationPath);
      const seed = crypto.createHash('sha256').update(chainXpriv.toBuffer()).digest();
      tss0.id.should.equal(crypto.createHash('sha256').update(crypto.createHash('sha256').update(seed).digest()).digest('hex'));
      tss0.m.should.equal(m);
      tss0.n.should.equal(n);
      tss0.partyId.should.equal(0);
    });

    it(happyPath('should create a join code'), function() {
      const code1 = tss0.createJoinCode({
        partyId: 1,
        partyPubKey: party1Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
      });
      should.exist(code1);
      code1.should.be.a('string');
      BitcoreLib.util.js.isHexaString(code1).should.equal(true);
      joinCode1 = code1;

      const code2 = tss0.createJoinCode({
        partyId: 2,
        partyPubKey: party2Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
      });
      should.exist(code2);
      code2.should.be.a('string');
      BitcoreLib.util.js.isHexaString(code2).should.equal(true);
      joinCode2 = code2;
    });

    it('should not produce a deterministic join code', function() {
      const code = tss0.createJoinCode({
        partyId: 1,
        partyPubKey: party1Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
      });
      should.exist(code);
      code.should.be.a('string');
      BitcoreLib.util.js.isHexaString(code).should.equal(true);
      code.should.not.equal(joinCode1);
    });

    it('should encode the join code per the encoding option', function() {
      const code = tss0.createJoinCode({
        partyId: 1,
        partyPubKey: party1Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey,
        opts: { encoding: 'base64' }
      });
      should.exist(code);
      code.should.be.a('string');
      code.should.not.equal(joinCode1);
      BitcoreLib.util.js.isHexaString(code).should.equal(false);
    });

    it('should expose the creator request public key of a join code', function() {
      const joiner = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key: party1Key });
      const decoded = joiner.checkJoinCode({ code: joinCode1 });
      decoded.partyId.should.equal(1);
      decoded.creatorPubKey.should.equal(tss0.getAuthPublicKey());
    });

    it('should not allow other party to use join code', async function() {
      try {
        const tss = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party2Key
        });
        // party2 should not be able to use party1's join code
        const result = await tss.joinKey({ code: joinCode1 });
        throw new Error('Should not have been able to join');
      } catch (err) {
        err.message.should.equal('Invalid checksum');
      }
    });

    it(happyPath('should use the join code to join a keygen session'), async function() {
      // party 1
      tss1 = new TssKeyGen({
        chain,
        network,
        baseUrl: '/bws/api',
        request: request(app),
        key: party1Key
      });
      let result = await tss1.joinKey({ code: joinCode1 });
      should.exist(result);
      result.should.equal(tss1);
      tss1.id.should.equal(tss0.id);
      tss1.m.should.equal(m);
      tss1.n.should.equal(n);
      tss1.partyId.should.equal(1);

      // party 2
      tss2 = new TssKeyGen({
        chain,
        network,
        baseUrl: '/bws/api',
        request: request(app),
        key: party2Key
      });
      result = await tss2.joinKey({ code: joinCode2 });
      should.exist(result);
      result.should.equal(tss2);
      tss2.id.should.equal(tss0.id);
      tss2.m.should.equal(m);
      tss2.n.should.equal(n);
      tss2.partyId.should.equal(2);
    });

    it(happyPath('should start round 1 by party1'), async function() {
      const e0 = tss0.exportSession();
      const e1 = tss1.exportSession();
      const e2 = tss2.exportSession();
      const sesh = await storage.fetchTssKeyGenSession({ id: tss0.id });

      // I chose to start the round with party 1. In practice, anyone can start the round
      const response = new Promise(r => tss1.once('roundsubmitted', r));
      tss1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss1.subscribe({ timeout: 10, iterHandler: () => tss1.unsubscribe() });
      const submittedRound = await response;
      submittedRound.should.equal(1);
    });

    it('should not allow party1 to go on to the next round', function(done) {
      const doReqSpy = sandbox.spy(Request.prototype, 'doRequest');
      tss1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss1.subscribe({ timeout: 10, iterHandler: () => {
        tss1.unsubscribe();
        doReqSpy.callCount.should.equal(1);
        doReqSpy.args[0][0].should.equal('get');
        doReqSpy.args[0][1].should.include(`/v1/tss/keygen/${tss1.id}/1?r=`);
        done();
      } });
    });

    it(happyPath('should continue round 1'), async function() {
      const response0 = new Promise(r => tss0.once('roundsubmitted', r));
      const response2 = new Promise(r => tss2.once('roundsubmitted', r));
      tss0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss2.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss0.subscribe({ timeout: 10, iterHandler: () => tss0.unsubscribe() });
      tss2.subscribe({ timeout: 10, iterHandler: () => tss2.unsubscribe() });
      const submitted0Round = await response0;
      const submitted2Round = await response2;
      submitted0Round.should.equal(1);
      submitted2Round.should.equal(1);
    });

    it('should export and restore the session', async function() {
      const s0 = tss0.exportSession();
      const s1 = tss1.exportSession();
      const s2 = tss2.exportSession();
      should.exist(s0);
      should.exist(s1);
      should.exist(s2);
      s0.should.be.a('string');
      s1.should.be.a('string');
      s2.should.be.a('string');

      tss0 = await new TssKeyGen({
        chain,
        network,
        baseUrl: '/bws/api',
        request: request(app),
        key: party0Key
      }).restoreSession({ session: s0 });

      tss1 = await new TssKeyGen({
        chain,
        network,
        baseUrl: '/bws/api',
        request: request(app),
        key: party1Key
      }).restoreSession({ session: s1 });
      
      tss2 = await new TssKeyGen({
        chain,
        network,
        baseUrl: '/bws/api',
        request: request(app),
        key: party2Key
      }).restoreSession({ session: s2 });
    });

    it(happyPath('should do round 2 (with API fault tolerance)'), async function() {
      // fault tolerance setup
      const postStub = sandbox.stub(Request.prototype, 'post').throws(new Error('restore me'));
      const t0RestoreSessionSpy = sandbox.spy(tss0, 'restoreSession');
      const t1RestoreSessionSpy = sandbox.spy(tss1, 'restoreSession');
      const t2RestoreSessionSpy = sandbox.spy(tss2, 'restoreSession');
      function restore() { postStub.restore?.(); };

      const response0 = new Promise(r => tss0.once('roundsubmitted', r));
      const response1 = new Promise(r => tss1.once('roundsubmitted', r));
      const response2 = new Promise(r => tss2.once('roundsubmitted', r));
      tss0.on('error', (e) => { e.message === 'restore me' ? restore() : should.not.exist(e?.message ?? e); });
      tss1.on('error', (e) => { e.message === 'restore me' ? restore() : should.not.exist(e?.message ?? e); });
      tss2.on('error', (e) => { e.message === 'restore me' ? restore() : should.not.exist(e?.message ?? e); });
      tss0.subscribe({ timeout: 10, iterHandler: () => tss0.unsubscribe() });
      tss1.subscribe({ timeout: 10, iterHandler: () => tss1.unsubscribe() });
      tss2.subscribe({ timeout: 10, iterHandler: () => tss2.unsubscribe() });
      const submitted0Round = await response0;
      submitted0Round.should.equal(2);
      const submitted1Round = await response1;
      submitted1Round.should.equal(2);
      const submitted2Round = await response2;
      submitted2Round.should.equal(2);
      // check that the fault tolerance worked
      (t0RestoreSessionSpy.callCount + t1RestoreSessionSpy.callCount + t2RestoreSessionSpy.callCount).should.be.gte(1);
    });

    it(happyPath('should do round 3'), async function() {
      const response0 = new Promise(r => tss0.once('roundsubmitted', r));
      const response1 = new Promise(r => tss1.once('roundsubmitted', r));
      const response2 = new Promise(r => tss2.once('roundsubmitted', r));
      tss0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss2.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss0.subscribe({ timeout: 10, iterHandler: () => tss0.unsubscribe() });
      tss1.subscribe({ timeout: 10, iterHandler: () => tss1.unsubscribe() });
      tss2.subscribe({ timeout: 10, iterHandler: () => tss2.unsubscribe() });
      const submitted0Round = await response0;
      submitted0Round.should.equal(3);
      const submitted1Round = await response1;
      submitted1Round.should.equal(3);
      const submitted2Round = await response2;
      submitted2Round.should.equal(3);
    });

    it(happyPath('should do round 4'), async function() {
      // round 4 does not emit a roundsubmitted event b/c the keychain is ready
      const response0 = new Promise(r => tss0.once('roundprocessed', r));
      const response1 = new Promise(r => tss1.once('roundprocessed', r));
      const response2 = new Promise(r => tss2.once('roundprocessed', r));
      const complete = new Promise(r => tss0.once('complete', r));
      tss0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss2.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss0.subscribe({ timeout: 10, iterHandler: () => tss0.unsubscribe() });
      tss1.subscribe({ timeout: 10, iterHandler: () => tss1.unsubscribe() });
      tss2.subscribe({ timeout: 10, iterHandler: () => tss2.unsubscribe() });
      const processed0Round = await response0;
      processed0Round.should.equal(4);
      const processed1Round = await response1;
      processed1Round.should.equal(4);
      const processed2Round = await response2;
      processed2Round.should.equal(4);
      // ensure that the rounds are completed so-as to prevent a race condition with the following test(s)
      await complete;
    });

    it(happyPath('should have stored the shared pub key'), async function() {
      const session = await storage.fetchTssKeyGenSession({ id: tss0.id });
      should.exist(session.sharedPublicKey);

      const key = tss0.getTssKey();
      should.exist(key);
      key.keychain.commonKeyChain.should.equal(session.sharedPublicKey);
    });

    it(happyPath('should have not stored the encrypted key shares'), async function() {
      const session = await storage.fetchTssKeyGenSession({ id: tss0.id });
      session.keyShares.length.should.equal(n);
      session.keyShares.every(share => share == null).should.equal(true); // encrypted keyshares are not stored
      return;

      // If we every decide to store the encrypted key shares...
      const key0 = tss0.getTssKey();
      const hdKey0 = new BitcoreLib.HDPrivateKey(party0Key.get().xPrivKey).deriveChild(derivationPath);
      const expected0 = key0.keychain.privateKeyShare.toString('base64') + ':' + key0.keychain.reducedPrivateKeyShare.toString('base64');
      ECIES.decrypt({
        payload: Buffer.from(session.keyShares[0], 'base64'),
        privateKey: hdKey0.privateKey,
        publicKey: hdKey0.publicKey
      }).toString().should.equal(expected0);
      const key1 = tss1.getTssKey();
      const hdKey1 = new BitcoreLib.HDPrivateKey(party1Key.get().xPrivKey).deriveChild(derivationPath);
      const expected1 = key1.keychain.privateKeyShare.toString('base64') + ':' + key1.keychain.reducedPrivateKeyShare.toString('base64');
      ECIES.decrypt({
        payload: Buffer.from(session.keyShares[1], 'base64'),
        privateKey: hdKey1.privateKey,
        publicKey: hdKey1.publicKey
      }).toString().should.equal(expected1);
      const key2 = tss2.getTssKey();
      const hdKey2 = new BitcoreLib.HDPrivateKey(party2Key.get().xPrivKey).deriveChild(derivationPath);
      const expected2 = key2.keychain.privateKeyShare.toString('base64') + ':' + key2.keychain.reducedPrivateKeyShare.toString('base64');
      ECIES.decrypt({
        payload: Buffer.from(session.keyShares[2], 'base64'),
        privateKey: hdKey2.privateKey,
        publicKey: hdKey2.publicKey
      }).toString().should.equal(expected2);
    });

    it('should not export a completed session', function() {
      should.throw(() => { tss0.exportSession(); }, /Cannot export a completed session/);
    });

    it('should cleanly handle a subscription to a finished session', async function() {
      const tss0EmitSpy = sandbox.spy(tss0, 'emit');
      const complete = new Promise(r => tss0.once('complete', r));
      tss0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      tss0.subscribe({ timeout: 10, iterHandler: () => tss0.unsubscribe() });
      await complete;
      tss0EmitSpy.args.filter(o => o[0] === 'roundready').length.should.equal(0);
      tss0EmitSpy.args.filter(o => o[0] === 'tsskey').length.should.equal(1);
      tss0EmitSpy.args.filter(o => o[0] === 'complete').length.should.equal(1);
    });

    // Keeping for documentation purposes
    it.skip('SKIP ME - save to data dir', function() { 
      fs.writeFileSync(`${datadir}/tss-party0.json`, JSON.stringify({ key: party0Key.toObj(), tss: tss0.getTssKey().toObj() }, null, 2));
      fs.writeFileSync(`${datadir}/tss-party1.json`, JSON.stringify({ key: party1Key.toObj(), tss: tss1.getTssKey().toObj() }, null, 2));
      fs.writeFileSync(`${datadir}/tss-party2.json`, JSON.stringify({ key: party2Key.toObj(), tss: tss2.getTssKey().toObj() }, null, 2));
    });

    describe('With Password', function() {
      const password = 'super|secret:password';

      async function setupSession(password) {
        const party0Key = new Key({ seedType: 'new' });
        const party1Key = new Key({ seedType: 'new' });
        const party2Key = new Key({ seedType: 'new' });
        const tss0 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party0Key
        });
        const tss1 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party1Key
        });
        const tss2 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party2Key
        });
        await tss0.newKey({ m, n, password });
        return { tss0, tss1, tss2, party0Key, party1Key, party2Key };
      };

      it(happyPath('should start a new keygen session with a password'), async function() {
        const party0Key = new Key({ seedType: 'new' });
        const tss0 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party0Key
        });
        const result = await tss0.newKey({ m, n, password });
        should.exist(result);
        result.should.equal(tss0);
        tss0.id.should.be.a('string');
        const chainXpriv = BitcoreLib.HDPrivateKey.fromString(party0Key.get().xPrivKey).deriveChild(derivationPath);
        const seed = crypto.createHash('sha256').update(chainXpriv.toBuffer()).digest();
        tss0.id.should.equal(crypto.createHash('sha256').update(crypto.createHash('sha256').update(seed).digest()).digest('hex'));
        tss0.m.should.equal(m);
        tss0.n.should.equal(n);
        tss0.partyId.should.equal(0);
        const session = await storage.fetchTssKeyGenSession({ id: tss0.id });
        should.exist(session.joinPassword);
      });

      it(happyPath('should join key with a password'), async function() {
        const { tss0, tss1, tss2, ...keys } = await setupSession(password);
        const code1 = tss0.createJoinCode({
          partyId: 1,
          partyPubKey: keys.party1Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
        });
        should.exist(code1);
        await tss1.joinKey({ code: code1, password });
        const session = await storage.fetchTssKeyGenSession({ id: tss1.id });
        session.participants.should.deep.equal([
          keys.party0Key.createCredentials(null, { chain, network, n: 1, account: 0 }).copayerId,
          keys.party1Key.createCredentials(null, { chain, network, n: 1, account: 0 }).copayerId,
          null
        ]);
      });

      it(happyPath('should join key with a password embedded in the join code'), async function() {
        const { tss0, tss1, tss2, ...keys } = await setupSession(password);
        const code1 = tss0.createJoinCode({
          partyId: 1,
          partyPubKey: keys.party1Key.createCredentials(null, { chain, network, n: 1, account: 0 }).requestPubKey,
          extra: password
        });
        should.exist(code1);
        await tss1.joinKey({ code: code1 });
        const session = await storage.fetchTssKeyGenSession({ id: tss1.id });
        session.participants.should.deep.equal([
          keys.party0Key.createCredentials(null, { chain, network, n: 1, account: 0 }).copayerId,
          keys.party1Key.createCredentials(null, { chain, network, n: 1, account: 0 }).copayerId,
          null
        ]);
      });

      it('should NOT join key with a WRONG password', async function() {
        const { tss0, tss1, tss2, ...keys } = await setupSession(password);
        const code1 = tss0.createJoinCode({
          partyId: 1,
          partyPubKey: keys.party1Key.createCredentials(null, { chain, network, n: 1, account: 0 }).requestPubKey
        });
        should.exist(code1);
        try {
          await tss1.joinKey({ code: code1, password: 'wrongpassword' });
          throw new Error('should have thrown');
        } catch (err) {
          err.message.should.include('TSS_INVALID_PASSWORD');
        }
        const session = await storage.fetchTssKeyGenSession({ id: tss1.id });
        session.participants.should.deep.equal([
          keys.party0Key.createCredentials(null, { chain, network, n: 1, account: 0 }).copayerId,
          null, // not joined
          null
        ]);
      });

      it('should NOT join key with a MISSING password', async function() {
        const { tss0, tss1, tss2, ...keys } = await setupSession(password);
        const code1 = tss0.createJoinCode({
          partyId: 1,
          partyPubKey: keys.party1Key.createCredentials(null, { chain, network, n: 1, account: 0 }).requestPubKey
        });
        should.exist(code1);
        try {
          await tss1.joinKey({ code: code1 });
          throw new Error('should have thrown');
        } catch (err) {
          err.message.should.include('TSS_INVALID_PASSWORD');
        }
        const session = await storage.fetchTssKeyGenSession({ id: tss1.id });
        session.participants.should.deep.equal([
          keys.party0Key.createCredentials(null, { chain, network, n: 1, account: 0 }).copayerId,
          null, // not joined
          null
        ]);
      });
    });

    describe('Out of partyId order', function() {
      let tss0: TssKeyGen;
      let tss1: TssKeyGen;
      let tss2: TssKeyGen;

      afterEach(function() {
        tss0?.unsubscribe();
        tss1?.unsubscribe();
        tss2?.unsubscribe();
      });

      it(happyPath('should generate the key when parties join out of partyId order'), async function() {
        const party0Key = new Key({ seedType: 'new' });
        const party1Key = new Key({ seedType: 'new' });
        const party2Key = new Key({ seedType: 'new' });
        tss0 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party0Key
        });
        tss1 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party1Key
        });
        tss2 = new TssKeyGen({
          chain,
          network,
          baseUrl: '/bws/api',
          request: request(app),
          key: party2Key
        });
        await tss0.newKey({ m, n });
        const code1 = tss0.createJoinCode({
          partyId: 1,
          partyPubKey: party1Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
        });
        const code2 = tss0.createJoinCode({
          partyId: 2,
          partyPubKey: party2Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
        });

        await tss2.joinKey({ code: code2 });
        await tss1.joinKey({ code: code1 });
        let session = await storage.fetchTssKeyGenSession({ id: tss0.id });
        session.rounds[0].map(message => message.fromPartyId).should.deep.equal([0, 2, 1]);

        const complete0 = new Promise(r => tss0.once('complete', r));
        const complete1 = new Promise(r => tss1.once('complete', r));
        const complete2 = new Promise(r => tss2.once('complete', r));
        tss0.on('error', (e) => { should.not.exist(e?.message ?? e); });
        tss1.on('error', (e) => { should.not.exist(e?.message ?? e); });
        tss2.on('error', (e) => { should.not.exist(e?.message ?? e); });
        tss0.subscribe({ timeout: 10 });
        tss1.subscribe({ timeout: 10 });
        tss2.subscribe({ timeout: 10 });
        await Promise.all([complete0, complete1, complete2]);

        session = await storage.fetchTssKeyGenSession({ id: tss0.id });
        tss0.getTssKey().keychain.commonKeyChain.should.equal(session.sharedPublicKey);
        tss1.getTssKey().keychain.commonKeyChain.should.equal(session.sharedPublicKey);
        tss2.getTssKey().keychain.commonKeyChain.should.equal(session.sharedPublicKey);
      });
    });
  });


  describe('Signing', function() {
    let sig0;
    let sig1;
    let export0;
    let export1;
    let party0Creds;
    let party1Creds;
    let party2Creds;
    let party0TssKey;
    let party1TssKey;
    let party2TssKey;
    const message = 'hello world';
    const messageHash = BitcoreLib.crypto.Hash.sha256(Buffer.from(message));
    const derivationPath = 'm/0/0';

    before(async function() {
      ({
        tssKeys: [party0TssKey, party1TssKey, party2TssKey],
        credentials: [party0Creds, party1Creds, party2Creds]
      } = await ensureSharedTssWallet());
    });

    it(happyPath('should start a new signing session'), async function() {
      sig1 = new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party1Creds,
        tssKey: party1TssKey,
      });
      const result = await sig1.start({ messageHash, derivationPath });
      should.exist(result);
      result.should.be.instanceOf(TssSign);
      result.should.equal(sig1);
      sig1.id.should.be.a('string');
      sig1.id.should.equal(BitcoreLib.crypto.Hash.sha256sha256(Buffer.from(message)).toString('hex'));
    });

    it(happyPath('should join a signing session'), async function() {
      sig0 = new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party0Creds,
        tssKey: party0TssKey,
      });
      const result = await sig0.start({ messageHash, derivationPath });
      should.exist(result);
      result.should.be.instanceOf(TssSign);
      result.should.equal(sig0);
      sig0.id.should.equal(sig1.id);
    });

    it(happyPath('should emit copayerReady for self on start() and for remote on subscribe()'), async function() {
      const copayerReadyIds: string[] = [];
      const sigA = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: party0Creds, tssKey: party0TssKey });
      const sigB = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: party1Creds, tssKey: party1TssKey });
      sigA.on('copayerReady', (id) => copayerReadyIds.push(id));
      await sigA.start({ id: 'copayer-ready-test', messageHash, derivationPath });
      copayerReadyIds.should.deep.equal([party0Creds.copayerId]);
      await sigB.start({ id: 'copayer-ready-test', messageHash, derivationPath });
      sigA.on('error', (e) => { should.not.exist(e?.message ?? e); });
      const roundsubmitted = new Promise(r => sigA.once('roundsubmitted', r));
      sigA.subscribe({ timeout: 10, iterHandler: () => sigA.unsubscribe() });
      await roundsubmitted;
      copayerReadyIds.should.include(party0Creds.copayerId);
      copayerReadyIds.should.include(party1Creds.copayerId);
    });

    it('should reject too many participants', async function() {
      const sig2 = new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party2Creds,
        tssKey: party2TssKey,
      });
      try {
        await sig2.start({ messageHash, derivationPath });
        throw new Error('Should have thrown');
      } catch (err) {
        err.message.should.include('TSS_MAX_PARTICIPANTS_REACHED');
      }
    });

    it(happyPath('should do round 1'), async function() {
      const response0 = new Promise(r => sig0.once('roundsubmitted', r));
      const response1 = new Promise(r => sig1.once('roundsubmitted', r));
      sig0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      sig1.subscribe({ timeout: 10, iterHandler: () => sig1.unsubscribe() });
      const submitted0Round = await response0;
      const submitted1Round = await response1;
      submitted0Round.should.equal(1);
      submitted1Round.should.equal(1);
    });

    it('should export and restore the session', async function() {
      // This test is between rounds 1 & 2 to help debug if the export/restore is working.
      // If round 1 test succeeds but 2 fails, the session restoration may be the reason.

      export0 = sig0.exportSession();
      export1 = sig1.exportSession();
      should.exist(export0);
      should.exist(export1);
      export0.should.be.a('string');
      export1.should.be.a('string');

      sig0 = await new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party0Creds,
        tssKey: party0TssKey,
      }).restoreSession({ session: export0 });

      sig1 = await new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party1Creds,
        tssKey: party1TssKey,
      }).restoreSession({ session: export1 });

      sig0.should.be.instanceOf(TssSign);
      sig1.should.be.instanceOf(TssSign);
    });

    it(happyPath('should do round 2'), async function() {
      const response0 = new Promise(r => sig0.once('roundsubmitted', r));
      const response1 = new Promise(r => sig1.once('roundsubmitted', r));
      sig0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      sig1.subscribe({ timeout: 10, iterHandler: () => sig1.unsubscribe() });
      const submitted0Round = await response0;
      const submitted1Round = await response1;
      submitted0Round.should.equal(2);
      submitted1Round.should.equal(2);
    });

    it('should error for a duplicate round message', async function() {
      const sig0 = await new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party0Creds,
        tssKey: party0TssKey,
      }).restoreSession({ session: export0 });
      const emitSpy = sandbox.spy(sig0, 'emit');
      const error = new Promise<Error>(r => sig0.on('error', r));
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      const e = await error;
      emitSpy.callCount.should.equal(4);
      emitSpy.args[0][0].should.equal('copayerReady');
      emitSpy.args[1][0].should.equal('roundready');
      emitSpy.args[2][0].should.equal('roundprocessed');
      emitSpy.args[3][0].should.equal('error');
      emitSpy.args[3][1].should.equal(e);
      e.message.should.include('TSS_ROUND_ALREADY_DONE');
    });

    it('should roll back an encrypted signing session without masking the original error', async function() {
      const password = 'encrypted-tss-password';
      party0TssKey.encrypt(password, { iter: 1 });

      try {
        should.not.exist(party0TssKey.keychain.privateKeyShare);

        const encryptedSig = await new TssSign({
          baseUrl: '/bws/api',
          request: request(app),
          credentials: party0Creds,
          tssKey: party0TssKey,
        }).restoreSession({ session: export0, password });

        const error = new Promise<Error>(r => encryptedSig.once('error', r));
        encryptedSig.subscribe({ timeout: 10 });
        const e = await error;
        encryptedSig.unsubscribe();

        e.message.should.include('TSS_ROUND_ALREADY_DONE');
        e.message.should.not.include('password is required');

        const retryError = new Promise<Error>(r => encryptedSig.once('error', r));
        encryptedSig.subscribe({ timeout: 10 });
        const retry = await retryError;
        encryptedSig.unsubscribe();

        retry.message.should.include('TSS_ROUND_ALREADY_DONE');
        retry.message.should.not.include('password is required');
      } finally {
        party0TssKey.decrypt(password);
      }
    });

    it(happyPath('should do round 3'), async function() {
      const response0 = new Promise(r => sig0.once('roundsubmitted', r));
      const response1 = new Promise(r => sig1.once('roundsubmitted', r));
      sig0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      sig1.subscribe({ timeout: 10, iterHandler: () => sig1.unsubscribe() });
      const submitted0Round = await response0;
      const submitted1Round = await response1;
      submitted0Round.should.equal(3);
      submitted1Round.should.equal(3);
    });

    it(happyPath('should do round 4'), async function() {
      // round 4 does not emit a roundsubmitted event b/c the signature is ready
      const response0 = new Promise(r => sig0.once('roundprocessed', r));
      const response1 = new Promise(r => sig1.once('roundprocessed', r));
      const signature = new Promise(r => sig1.once('signature', r));
      const complete = new Promise(r => sig0.once('complete', r));
      sig0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig1.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      sig1.subscribe({ timeout: 10, iterHandler: () => sig1.unsubscribe() });
      const processed0Round = await response0;
      const processed1Round = await response1;
      processed0Round.should.equal(4);
      processed1Round.should.equal(4);
      // ensure that the rounds are completed so-as to prevent
      await complete;
      const sig = await signature;
      should.exist(sig);
    });

    it(happyPath('should have the signature'), async function() {
      const sig = sig0.getSignature();
      should.exist(sig);
      sig.r.should.be.a('string');
      sig.s.should.be.a('string');
      sig.v.should.be.a('number');
      sig.pubKey.should.be.a('string');
    });

    it(happyPath('should have stored the signature'), async function() {
      const session = await storage.fetchTssSigSession({ id: sig0.id });
      const sig = sig0.getSignature();
      should.exist(session.signature);
      session.signature.should.deep.equal(sig);
    });

    it('should have a matchin pubKey with bitcore', function() {
      const sig = sig0.getSignature();
      const xpub = party0TssKey.getXPubKey();
      const pubKey = BitcoreLib.HDPublicKey(xpub).deriveChild(derivationPath || 'm').publicKey.toString('hex');
      sig.pubKey.should.equal(pubKey);
    });

    it('should not export a completed session', function() {
      should.throw(() => { sig0.exportSession(); }, /Cannot export a completed session/);
    });

    it('should cleanly handle a subscription to a finished session', async function() {
      sandbox.spy(sig0, 'emit');
      const complete = new Promise(r => sig0.once('complete', r));
      sig0.on('error', (e) => { should.not.exist(e?.message ?? e); });
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      await complete;
      sig0.emit.args.filter(o => o[0] === 'roundready').length.should.equal(0);
      sig0.emit.args.filter(o => o[0] === 'signature').length.should.equal(1);
      sig0.emit.args.filter(o => o[0] === 'complete').length.should.equal(1);
    });

    it('should emit the signature for an outdated local but finished remote session', async function() {
      const sig0 = await new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party0Creds,
        tssKey: party0TssKey,
      }).restoreSession({ session: export0 });
      const emitSpy = sandbox.spy(sig0, 'emit');
      const signature = new Promise(r => sig0.once('signature', r));
      const complete = new Promise(r => sig0.once('complete', r));
      sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
      const sig = await signature;
      await complete;
      should.exist(sig);
      emitSpy.args.filter(o => o[0] === 'roundready').length.should.equal(1);
      emitSpy.args.filter(o => o[0] === 'roundprocessed').length.should.equal(1);
      emitSpy.args.filter(o => o[0] === 'roundsubmitted').length.should.equal(0); // b/c body.signature exists
    });

    it('should sign a message with a custom id', async function() {
      const sig0 = new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party0Creds,
        tssKey: party0TssKey,
      });
      const sig2 = new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party2Creds,
        tssKey: party2TssKey,
      });
      const id = 'my-custom-id';
      await sig0.start({ id, messageHash, derivationPath });
      await sig2.start({ id, messageHash, derivationPath });
      const complete0 = new Promise(r => sig0.once('complete', r));
      const complete2 = new Promise(r => sig2.once('complete', r));
      sig0.subscribe({ timeout: 10 });
      sig2.subscribe({ timeout: 10 });
      await Promise.all([complete0, complete2]);
      const sig = sig0.getSignature();
      should.exist(sig);
    });

    it('should error on a duplicate session id', async function() {
      const sig0 = new TssSign({
        baseUrl: '/bws/api',
        request: request(app),
        credentials: party0Creds,
        tssKey: party0TssKey,
      });
      try {
        await sig0.start({ messageHash });
        throw new Error('Should have thrown');
      } catch (err) {
        err.message.should.include('TSS_ROUND_ALREADY_DONE');
      }
    });
  
  });

  describe('TssKey', function() {
    const expectedPrivateKeyShare = Buffer.from('aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233', 'hex');
    const expectedReducedPrivateKeyShare = Buffer.from('11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd', 'hex');

    function createTssKey(): TssKey {
      const key = new Key({ seedType: 'new' });
      return new TssKey({
        ...key.toObj(),
        keychain: {
          privateKeyShare: expectedPrivateKeyShare,
          privateKeyShareEncrypted: null,
          reducedPrivateKeyShare: expectedReducedPrivateKeyShare,
          reducedPrivateKeyShareEncrypted: null,
          commonKeyChain: '03' + 'aabbccdd00112233'.repeat(6),
        },
        metadata: { id: 'test-tss-id', m: 2, n: 3, partyId: 0 },
      });
    }

    describe('toObj', function() {
      describe('buffer serialization', function () {
        function assertKeychainBuffers(tssKey: TssKey) {
          Buffer.isBuffer(tssKey.keychain.privateKeyShare).should.be.true;
          Buffer.isBuffer(tssKey.keychain.reducedPrivateKeyShare).should.be.true;
        }

        it('should return Buffer instances in the keychain after toObj()', function () {
          const tssKey = createTssKey();
          assertKeychainBuffers(tssKey);
          Buffer.compare(tssKey.keychain.privateKeyShare, expectedPrivateKeyShare).should.equal(0);
          Buffer.compare(tssKey.keychain.reducedPrivateKeyShare, expectedReducedPrivateKeyShare).should.equal(0);

          const exported = tssKey.toObj();

          Buffer.isBuffer(exported.keychain.privateKeyShare).should.be.true;
          Buffer.isBuffer(exported.keychain.reducedPrivateKeyShare).should.be.true;

          // Ensure that the exported buffers are not the same references as the original TssKey buffers
          exported.keychain.privateKeyShare.should.not.equal(tssKey.keychain.privateKeyShare);
          exported.keychain.reducedPrivateKeyShare.should.not.equal(tssKey.keychain.reducedPrivateKeyShare);
        });

        it('should preserve buffer contents after toObj()', function () {
          const tssKey = createTssKey();
          assertKeychainBuffers(tssKey);

          const exported = tssKey.toObj();

          Buffer.isBuffer(exported.keychain.privateKeyShare).should.be.true;
          Buffer.isBuffer(exported.keychain.reducedPrivateKeyShare).should.be.true;

          Buffer.compare(exported.keychain.privateKeyShare, expectedPrivateKeyShare).should.equal(0);
          Buffer.compare(exported.keychain.reducedPrivateKeyShare, expectedReducedPrivateKeyShare).should.equal(0);
        });

        it('should survive a full JSON.stringify → JSON.parse round-trip', function () {
          const tssKey = createTssKey();
          assertKeychainBuffers(tssKey);

          const exported = tssKey.toObj();
          const serialized = JSON.stringify(exported);
          const loaded = JSON.parse(serialized, (key, value) => {
            if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
              return Buffer.from(value.data);
            }
            return value;
          });

          Buffer.isBuffer(loaded.keychain.privateKeyShare).should.be.true;
          Buffer.isBuffer(loaded.keychain.reducedPrivateKeyShare).should.be.true;

          Buffer.compare(loaded.keychain.privateKeyShare, expectedPrivateKeyShare).should.equal(0);
          Buffer.compare(loaded.keychain.reducedPrivateKeyShare, expectedReducedPrivateKeyShare).should.equal(0);
        });

        it('should allow constructing a new TssKey from toObj() output with valid Buffers', function () {
          const tssKey = createTssKey();
          assertKeychainBuffers(tssKey);

          const exported = tssKey.toObj();
          const reconstructed = new TssKey(exported);

          assertKeychainBuffers(reconstructed);
          Buffer.compare(reconstructed.keychain.privateKeyShare, expectedPrivateKeyShare).should.equal(0);
          Buffer.compare(reconstructed.keychain.reducedPrivateKeyShare, expectedReducedPrivateKeyShare).should.equal(0);
        });
      });
    });
  });

  describe('TSS key wallets', function() {
    let tssKeys: TssKey[];
    let ethClients: Client[];
    let members: TssKeyMember[];
    let roster: TssKeyRoster;
    const arbClients: Client[] = [];
    const recipient = '0x37d7B3bBD88EFdE6a93cF74D2F5b0385D3E3B08A';

    const rejection = (promise: Promise<any>) => promise.then(() => null, err => err);
    const requestOpts = (partyId: number) => ({ baseUrl: '/bws/api', request: request(app), copayerName: `party ${partyId}` });
    const findWallet = async (client: Client, walletChain: string) => (await client.getTssKeyWallets()).wallets.find(w => w.chain === walletChain);

    before(async function() {
      ({ tssKeys, clients: ethClients } = await ensureSharedTssWallet());
      members = ethClients.map((client, partyId) => ({ partyId, requestPubKey: client.credentials.requestPubKey }));
      roster = tssKeys[0].createRoster(members);
    });

    it(happyPath('should list the TSS key wallets'), async function() {
      const { wallets } = await ethClients[1].getTssKeyWallets();
      wallets.should.have.length(1);
      wallets[0].should.deep.include({ chain: 'eth', coin: 'eth', network: 'testnet', copayers: 3, joined: true, invite: null });
    });

    it('should reject TSS key wallets for chains that are not EVM or have no derivation path', async function() {
      const opts = { ...requestOpts(0), network: 'testnet' as const, walletName: 'tss wallet', members };
      (await rejection(tssKeys[0].createWalletForChain({ ...opts, chain: 'btc' }))).message.should.include('TSS key wallets can only be added for EVM chains');
      (await rejection(tssKeys[0].createWalletForChain({ ...opts, chain: 'arc' }))).message.should.include('unknown chain: arc');
    });

    it('should derive the copayer key of every derivable EVM chain with coin type 60', function() {
      const key = new Key({ seedType: 'new' });
      const derivationPath = (evmChain: string) => {
        try {
          return key.getBaseAddressDerivationPath({ chain: evmChain, n: 1, account: 0, network: 'livenet' });
        } catch {
          return null;
        }
      };
      const derivableChains = Constants.EVM_CHAINS.filter(evmChain => derivationPath(evmChain));
      derivableChains.should.include.members(['eth', 'matic', 'arb', 'base', 'op']);
      for (const evmChain of derivableChains) {
        derivationPath(evmChain).should.equal('m/44\'/60\'/0\'');
      }
    });

    it(happyPath('should create the TSS key wallet of another EVM chain and invite the other members'), async function() {
      const { client, wallet } = await tssKeys[0].createWalletForChain({
        ...requestOpts(0),
        chain: 'arb',
        coin: 'eth',
        network: 'testnet',
        walletName: 'tss arb wallet',
        members,
        roster
      });
      wallet.tssKeyId.should.equal(tssKeys[0].metadata.id);
      arbClients[0] = client;

      const arbWallet = await findWallet(ethClients[1], 'arb');
      arbWallet.should.deep.include({ id: wallet.id, coin: 'eth', network: 'testnet', copayers: 1, joined: false });
      arbWallet.invite.senderRequestPubKey.should.equal(members[0].requestPubKey);
    });

    it('should reject an invite from a sender that is not a verified member', async function() {
      const arbWallet = await findWallet(ethClients[1], 'arb');
      const err = await rejection(tssKeys[1].joinWalletFromInvite({ ...requestOpts(1), wallet: arbWallet, members: [members[1]], creatorPubKey: members[2].requestPubKey }));
      err.message.should.include('not a verified member');
    });

    it('should reject a tampered invite', async function() {
      const arbWallet = await findWallet(ethClients[1], 'arb');
      const encryptedSecret = Buffer.from(arbWallet.invite.encryptedSecret, 'base64');
      encryptedSecret[encryptedSecret.length - 1] = (encryptedSecret[encryptedSecret.length - 1] + 1) % 256;
      const tampered = { ...arbWallet, invite: { ...arbWallet.invite, encryptedSecret: encryptedSecret.toString('base64') } };
      const err = await rejection(tssKeys[1].joinWalletFromInvite({ ...requestOpts(1), wallet: tampered, members: [members[0], members[1]], creatorPubKey: members[0].requestPubKey }));
      err.message.should.include('Invalid checksum');
    });

    it('should reject an invite whose secret belongs to another wallet', async function() {
      const arbWallet = await findWallet(ethClients[1], 'arb');
      const ethWallet = await findWallet(ethClients[1], 'eth');
      const err = await rejection(tssKeys[1].joinWalletFromInvite({ ...requestOpts(1), wallet: { ...arbWallet, id: ethWallet.id }, members: [members[0], members[1]], creatorPubKey: members[0].requestPubKey }));
      err.message.should.include('TSS wallet invite does not match the wallet');
      (await findWallet(ethClients[1], 'arb')).should.deep.include({ copayers: 1, joined: false });
    });

    it('should reject a joined wallet that belongs to another TSS key', async function() {
      sandbox.stub(Client.prototype, 'joinWallet').resolves({ tssKeyId: 'another-tss-key' });
      const err = await rejection(tssKeys[1].joinWalletFromInvite({ ...requestOpts(1), wallet: await findWallet(ethClients[1], 'arb'), members: [members[0], members[1]], creatorPubKey: members[0].requestPubKey }));
      err.message.should.include('TSS key id mismatch');
    });

    it('should sort the roster and only trust an unchanged roster signed by the TSS key creator', function() {
      const unorderedMembers = [members[2], members[0], members[1]];
      const signedRoster = tssKeys[0].createRoster(unorderedMembers);
      const tssKeyId = tssKeys[0].metadata.id;
      signedRoster.members.should.deep.equal(members);
      unorderedMembers.map(member => member.partyId).should.deep.equal([2, 0, 1]);
      TssKey.verifyRoster({ roster: signedRoster, tssKeyId, creatorPubKey: members[0].requestPubKey }).should.equal(true);
      const permutedRoster = { ...signedRoster, members: [signedRoster.members[1], signedRoster.members[0], signedRoster.members[2]] };
      TssKey.verifyRoster({ roster: permutedRoster, tssKeyId, creatorPubKey: members[0].requestPubKey }).should.equal(false);
      TssKey.verifyRoster({ roster, tssKeyId, creatorPubKey: members[1].requestPubKey }).should.equal(false);
      const forged = { ...roster, members: [...roster.members, { partyId: 3, requestPubKey: members[1].requestPubKey }] };
      TssKey.verifyRoster({ roster: forged, tssKeyId, creatorPubKey: members[0].requestPubKey }).should.equal(false);
      (() => tssKeys[1].createRoster(members)).should.throw('only the TSS key creator can sign the roster');
    });

    it(happyPath('should join the TSS key wallet of another EVM chain from the invite'), async function() {
      const { client, roster: receivedRoster } = await tssKeys[1].joinWalletFromInvite({
        ...requestOpts(1),
        wallet: await findWallet(ethClients[1], 'arb'),
        members: [members[0], members[1]],
        creatorPubKey: members[0].requestPubKey
      });
      receivedRoster.should.deep.equal(roster);
      arbClients[1] = client;
      for (const arbClient of arbClients) {
        await arbClient.openWallet({ forceOpen: true });
        arbClient.isComplete().should.equal(true);
      }

      const ethAddress = await ethClients[0].createAddress();
      const arbAddress = await arbClients[1].createAddress();
      arbAddress.address.should.equal(ethAddress.address);
      (await findWallet(ethClients[1], 'arb')).should.deep.include({ copayers: 2, joined: true, invite: null });
    });

    it(happyPath('should accept and TSS sign a proposal of a member that joined later once the copayer ring is refreshed'), async function() {
      const { client: lateClient } = await tssKeys[2].joinWalletFromInvite({
        ...requestOpts(2),
        wallet: await findWallet(ethClients[2], 'arb'),
        members: [members[0], members[2]],
        creatorPubKey: members[0].requestPubKey
      });
      arbClients[2] = lateClient;
      await lateClient.openWallet({ forceOpen: true });

      const txp = await lateClient.createTxProposal({
        chain: 'arb',
        coin: 'eth',
        outputs: [{ toAddress: recipient, amount: 1000, gasLimit: 21000 }],
        feePerKb: 100e2,
        txType: 2
      } as any);
      const publishedTxp = await lateClient.publishTxProposal({ txp });
      publishedTxp.chain.should.equal('arb');

      const err = await rejection(arbClients[0].getTxProposals({}));
      err.should.be.instanceOf(Errors.SERVER_COMPROMISED);
      await arbClients[0].openWallet({ forceOpen: true });
      (await arbClients[0].getTxProposals({})).map(t => t.id).should.include(publishedTxp.id);

      const unsignedTx = Utils.buildTx(publishedTxp).uncheckedSerialize()[0];
      const messageHash = Buffer.from(Transactions.getSighash({ chain: 'ARB', tx: unsignedTx }), 'hex');
      const signature = await signWithTss(
        [
          { tssKey: tssKeys[0], credentials: arbClients[0].credentials },
          { tssKey: tssKeys[2], credentials: lateClient.credentials }
        ],
        messageHash,
        `${publishedTxp.id}:input0`
      );
      const serializedSignature = Transactions.transformSignatureObject({ chain: 'ARB', obj: signature });
      const signedTxp = await lateClient.pushSignatures(publishedTxp, [serializedSignature]);
      signedTxp.status.should.equal('accepted');

      const signedTx = ethers.Transaction.from(Transactions.applySignature({ chain: 'ARB', tx: unsignedTx, signature: serializedSignature }));
      signedTx.from.should.equal((await lateClient.createAddress()).address);
      signedTx.chainId.should.equal(421614n);
    });
  });

  describe('Client Versions', function() {
    // Intercepts Request.prototype.post and overrides the `version` field.
    // Pass `undefined` to omit version entirely (simulates pre-v1.1 legacy clients).
    function stubPostVersion(version: number | undefined) {
      const origPost = Request.prototype.post;
      sandbox.stub(Request.prototype, 'post').callsFake(function(url, body: any, cb) {
        if (version !== undefined) {
          return origPost.call(this, url, { ...body, version }, cb);
        } else {
          const { version: _v, ...rest } = body;
          return origPost.call(this, url, rest, cb);
        }
      });
    }

    describe('Key Generation', function() {
      it('should reject a too-old client version', async function() {
        stubPostVersion(0.9);
        const key = new Key({ seedType: 'new' });
        const tss = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key });
        try {
          await tss.newKey({ m, n });
          throw new Error('Should have thrown');
        } catch (err) {
          err.name.should.include('UPGRADE_NEEDED');
        }
      });

      it('should reject a too-new client version', async function() {
        stubPostVersion(2.0);
        const key = new Key({ seedType: 'new' });
        const tss = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key });
        try {
          await tss.newKey({ m, n });
          throw new Error('Should have thrown');
        } catch (err) {
          err.name.should.include('UPGRADE_NEEDED');
          err.message.should.include('TSS version too new');
        }
      });

      it('should accept a legacy client that omits the version field', async function() {
        // Pre-v1.1 clients did not send the version; the server defaults to 1.0
        stubPostVersion(undefined);
        const key = new Key({ seedType: 'new' });
        const tss = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key });
        const result = await tss.newKey({ m, n });
        should.exist(result);
        result.should.equal(tss);
      });

      it('should reject a version mismatch when joining a session', async function() {
        // Party 0 creates with current version (1.1); party 1 tries to join with old version (1.0)
        const party0Key = new Key({ seedType: 'new' });
        const party1Key = new Key({ seedType: 'new' });
        const tss0 = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key: party0Key });
        await tss0.newKey({ m, n }); // real version, creates session with schemeVersion 1.1

        const joinCode = tss0.createJoinCode({
          partyId: 1,
          partyPubKey: party1Key.createCredentials(null, { network, n: 1, account: 0 }).requestPubKey
        });

        stubPostVersion(1.0);
        const tss1 = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key: party1Key });
        try {
          await tss1.joinKey({ code: joinCode });
          throw new Error('Should have thrown');
        } catch (err) {
          err.message.should.include('TSS_MISMATCH_VERSION');
        }
      });
    });

    describe('Signing', function() {
      let vParty0TssKey: TssKey;
      let vParty1TssKey: TssKey;
      let vParty0Creds: Credentials;
      let vParty1Creds: Credentials;
      const vMessageHash = BitcoreLib.crypto.Hash.sha256(Buffer.from('client-version-test'));
      const vDerivPath = 'm/0/0';

      before(async function() {
        ({
          tssKeys: [vParty0TssKey, vParty1TssKey],
          credentials: [vParty0Creds, vParty1Creds]
        } = await ensureSharedTssWallet());
      });

      it('should reject a too-old client version', async function() {
        stubPostVersion(0.9);
        const sig = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: vParty0Creds, tssKey: vParty0TssKey });
        try {
          await sig.start({ id: 'version-old-sign', messageHash: vMessageHash, derivationPath: vDerivPath });
          throw new Error('Should have thrown');
        } catch (err) {
          err.name.should.include('UPGRADE_NEEDED');
        }
      });

      it('should reject a too-new client version', async function() {
        stubPostVersion(2.0);
        const sig = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: vParty0Creds, tssKey: vParty0TssKey });
        try {
          await sig.start({ id: 'version-new-sign', messageHash: vMessageHash, derivationPath: vDerivPath });
          throw new Error('Should have thrown');
        } catch (err) {
          err.name.should.include('UPGRADE_NEEDED');
          err.message.should.include('TSS version too new');
        }
      });

      it('should accept a legacy client that omits the version field', async function() {
        // Pre-v1.1 clients did not send the version; the server defaults to 1.0
        stubPostVersion(undefined);
        const sig0 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: vParty0Creds, tssKey: vParty0TssKey });
        const sig1 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: vParty1Creds, tssKey: vParty1TssKey });
        await sig0.start({ id: 'version-legacy-sign', messageHash: vMessageHash, derivationPath: vDerivPath });
        await sig1.start({ id: 'version-legacy-sign', messageHash: vMessageHash, derivationPath: vDerivPath });
        // No error: server treats missing version as 1.0, both sessions match
      });

      it('should reject a version mismatch when joining a signing session', async function() {
        // Party 0 creates with current version (1.1); party 1 tries to join with old version (1.0)
        const sig0 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: vParty0Creds, tssKey: vParty0TssKey });
        await sig0.start({ id: 'version-mismatch-sign', messageHash: vMessageHash, derivationPath: vDerivPath });

        stubPostVersion(1.0);
        const sig1 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: vParty1Creds, tssKey: vParty1TssKey });
        try {
          await sig1.start({ id: 'version-mismatch-sign', messageHash: vMessageHash, derivationPath: vDerivPath });
          throw new Error('Should have thrown');
        } catch (err) {
          err.message.should.include('TSS_MISMATCH_VERSION');
        }
      });
    });
  });

  describe('Session Expiration', function() {
    // Stubs Date.now() past the server's 20-minute default time limit
    function simulateExpiry(mins) {
      const now = Date.now();
      sandbox.stub(Date, 'now').returns(now + mins * 60 * 1000);
    }

    describe('Key Generation', function() {
      let tss0: TssKeyGen;
      let tss1: TssKeyGen;
      let tss2: TssKeyGen;

      beforeEach(async function() {
      });

      it('should emit an error when subscribing to an expired keygen session', async function() {
        const data = JSON.parse(fs.readFileSync(`${datadir}/initialKeyGenState.json`).toString());
        const key0 = new Key({ seedType: 'mnemonic', seedData: data.party0Mnemonic });
        const key1 = new Key({ seedType: 'mnemonic', seedData: data.party1Mnemonic });
        const key2 = new Key({ seedType: 'mnemonic', seedData: data.party2Mnemonic });
        tss0 = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key: key0 });
        tss1 = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key: key1 });
        tss2 = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key: key2 });
        await tss0.restoreSession({ session: data.party0Session });
        await tss1.restoreSession({ session: data.party1Session });
        await tss2.restoreSession({ session: data.party2Session });
        await storage.storeTssKeyGenSession({ doc: data.keygenModel });

        simulateExpiry(BwsDefaults.TSS_KEYGEN_TIME_LIMIT + 1); // 1 minute past the default limit

        const error0 = new Promise<IErrorSpec>(r => tss0.once('error', (e) => { tss0.unsubscribe(); r(e); }));
        tss0.subscribe({ timeout: 10, iterHandler: () => tss0.unsubscribe() });
        const error1 = new Promise<Error>(r => tss1.once('error', (e) => { tss1.unsubscribe(); r(e); }));
        tss1.subscribe({ timeout: 10, iterHandler: () => tss1.unsubscribe() });
        const error2 = new Promise<Error>(r => tss2.once('error', (e) => { tss2.unsubscribe(); r(e); }));
        tss2.subscribe({ timeout: 10, iterHandler: () => tss2.unsubscribe() });
        
        const err0 = await error0;
        err0.name.should.include('TSS_SESSION_EXPIRED');
        const err1 = await error1;
        err1.name.should.include('TSS_SESSION_EXPIRED');
        const err2 = await error2;
        err2.name.should.include('TSS_SESSION_EXPIRED');
      });

      it('should not expire a session before the time limit is reached', async function() {
        const key = new Key({ seedType: 'new' });
        const tss = new TssKeyGen({ chain, network, baseUrl: '/bws/api', request: request(app), key });
        await tss.newKey({ m, n });

        simulateExpiry(BwsDefaults.TSS_KEYGEN_TIME_LIMIT - 1); // 1 minute before the default limit

        // If the session were expired, an error event would fire and fail this test
        tss.on('error', (e) => { should.not.exist(e?.message ?? e); });
        await new Promise<void>(r => tss.subscribe({ timeout: 10, iterHandler: () => { tss.unsubscribe(); r(); } }));
      });
    });

    describe('Signing', function() {
      let eParty0TssKey: TssKey;
      let eParty1TssKey: TssKey;
      let eParty0Creds;
      let eParty1Creds;
      const eMessageHash = BitcoreLib.crypto.Hash.sha256(Buffer.from('expiry-test'));
      const eDerivPath = 'm/0/0';

      before(async function() {
        ({
          tssKeys: [eParty0TssKey, eParty1TssKey],
          credentials: [eParty0Creds, eParty1Creds]
        } = await ensureSharedTssWallet());
      });

      it('should emit an error when subscribing to an expired signing session', async function() {
        const sig0 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: eParty0Creds, tssKey: eParty0TssKey });
        const sig1 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: eParty1Creds, tssKey: eParty1TssKey });
        await sig0.start({ id: 'expiry-sign', messageHash: eMessageHash, derivationPath: eDerivPath });
        await sig1.start({ id: 'expiry-sign', messageHash: eMessageHash, derivationPath: eDerivPath });

        simulateExpiry(BwsDefaults.TSS_SIGGEN_TIME_LIMIT + 1); // 1 minute past the default limit

        const error = new Promise<IErrorSpec>(r => sig0.once('error', (e) => { sig0.unsubscribe(); r(e); }));
        sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
        const err = await error;
        err.name.should.include('TSS_SESSION_EXPIRED');
      });

      it('should not expire a signing session before the time limit is reached', async function() {
        const sig0 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: eParty0Creds, tssKey: eParty0TssKey });
        const sig1 = new TssSign({ baseUrl: '/bws/api', request: request(app), credentials: eParty1Creds, tssKey: eParty1TssKey });
        await sig0.start({ id: 'expiry-sign-valid', messageHash: eMessageHash, derivationPath: eDerivPath });
        await sig1.start({ id: 'expiry-sign-valid', messageHash: eMessageHash, derivationPath: eDerivPath });

        simulateExpiry(BwsDefaults.TSS_SIGGEN_TIME_LIMIT - 1); // 1 minute before the default limit

        const response0 = new Promise(r => sig0.once('roundsubmitted', r));
        const response1 = new Promise(r => sig1.once('roundsubmitted', r));
        sig0.on('error', (e) => { should.not.exist(e?.message ?? e); });
        sig1.on('error', (e) => { should.not.exist(e?.message ?? e); });
        sig0.subscribe({ timeout: 10, iterHandler: () => sig0.unsubscribe() });
        sig1.subscribe({ timeout: 10, iterHandler: () => sig1.unsubscribe() });
        const round0 = await response0;
        const round1 = await response1;
        round0.should.equal(1);
        round1.should.equal(1);
      });
    });
  });
});