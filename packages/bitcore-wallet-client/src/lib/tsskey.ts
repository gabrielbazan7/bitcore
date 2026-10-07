import { EventEmitter } from 'events';
import { ECDSA, ECIES } from '@bitpay-labs/bitcore-tss';
import { BitcoreLib } from '@bitpay-labs/crypto-wallet-core';
import { API as Client, CreateWalletOpts, TssKeyMember, TssKeyWallet } from './api';
import { Constants, Encryption, Utils } from './common';
import { Credentials } from './credentials';
import { ExportedKey, Key, KeyAlgorithm, PasswordMaybe } from './key';
import { Request, RequestResponse } from './request';

const $ = BitcoreLib.util.preconditions;

const { TSS_KEYGEN_VERSION } = Constants;

export interface ITssKeyGenConstructorParams {
  /**
   * Chain this key is for (e.g. 'btc', 'bch', 'eth')
   */
  chain: string;
  /**
   * Network this key is for (e.g. 'livenet', 'testnet', 'regtest')
   */
  network: 'livenet' | 'testnet' | 'regtest';
  /**
   * URL of the BWS server
   */
  baseUrl: string;
  /**
   * Key used for seeding generation, signing, and encrypting payloads
   */
  key: Key;
  /**
   * Password for `key` (if encrypted)
   */
  password?: string;
  /**
   * Pre-defined Request object for making HTTP requests.
   * For testing only
   */
  request?: Request;
  /**
   * Backup your encrypted key share to the server.
   * This allows for portability and recoverability with your xPrivKey.
   * Default: false
   * DISABLED
   */
  // backupKeyShare?: boolean;
};

export interface ITssKey extends Key {
  keychain: {
    privateKeyShare?: Buffer;
    privateKeyShareEncrypted?: string;
    reducedPrivateKeyShare?: Buffer;
    reducedPrivateKeyShareEncrypted?: string;
    commonKeyChain: string;
  };
  metadata: {
    id: string;
    m: number;
    n: number;
    partyId: number;
  };
};

export interface TssExportedKey extends ExportedKey {
  keychain: ITssKey['keychain'];
};

export interface TssKeyRoster {
  tssKeyId: string;
  members: TssKeyMember[];
  signature: string;
};

function getJoinCodeCreatorPubKey(code: Buffer): string {
  const pubKeyLength = code[0] === 4 ? 65 : 33;
  return BitcoreLib.PublicKey.fromDER(code.subarray(0, pubKeyLength)).toString();
}

export class TssKey extends Key implements ITssKey {
  keychain: ITssKey['keychain'];
  metadata: ITssKey['metadata'];
  credentials: Credentials;
  tssXPubKey: string;

  constructor(obj: ITssKey) {
    super({ seedType: 'object', seedData: obj });
    this.keychain = obj.keychain;
    this.metadata = obj.metadata;
  }

  toObj(): ITssKey {
    return {
      ...super.toObj(),
      // Create de-referenced copies
      keychain: {
        privateKeyShare: this.keychain.privateKeyShare ? Buffer.from(this.keychain.privateKeyShare) : undefined,
        privateKeyShareEncrypted: this.keychain.privateKeyShareEncrypted,
        reducedPrivateKeyShare: this.keychain.reducedPrivateKeyShare ? Buffer.from(this.keychain.reducedPrivateKeyShare) : undefined,
        reducedPrivateKeyShareEncrypted: this.keychain.reducedPrivateKeyShareEncrypted,
        commonKeyChain: this.keychain.commonKeyChain
      } as ITssKey['keychain'],
      metadata: {
        id: this.metadata.id,
        m: this.metadata.m,
        n: this.metadata.n,
        partyId: this.metadata.partyId
      } as ITssKey['metadata']
    };
  }

  createCredentials(
    password: PasswordMaybe,
    opts: {
      chain?: string;
      coin?: string;
      network: string;
      account: number;
      addressType?: string;
      walletPrivKey?: string;
      algo?: 'EDDSA' | 'ECDSA';
    }
  ): Credentials {
    this.tssXPubKey = this.getXPubKey(opts.network);
    // n is always 1 for TSS keys since they act like single-sig wallets
    const c = super.createCredentials(password, { ...opts, n: 1, tssXPubKey: this.tssXPubKey });
    this.credentials = c;
    this.credentials.m = 1;
    return c;
  }

  getXPubKey(network?: string): string {
    const publicKey = this.keychain.commonKeyChain.substring(0, 66);
    const chainCode = this.keychain.commonKeyChain.substring(66);
    const xPubKey = new BitcoreLib.HDPublicKey({
      network: BitcoreLib.Networks.get(network) || 'testnet',
      depth: 0,
      parentFingerPrint: 0,
      childIndex: 0,
      publicKey,
      chainCode
    });
    return xPubKey.toString();
  }

  isKeyChainEncrypted(): boolean {
    return !!this.keychain.privateKeyShareEncrypted;
  }

  get(password: PasswordMaybe, algo?: KeyAlgorithm): TssExportedKey {
    const keyObj = {
      ...super.get(password, algo),
      keychain: !this.isKeyChainEncrypted() ? { ...this.keychain } : {
        privateKeyShare: Encryption.decryptWithPassword(this.keychain.privateKeyShareEncrypted, password),
        reducedPrivateKeyShare: Encryption.decryptWithPassword(this.keychain.reducedPrivateKeyShareEncrypted, password),
        commonKeyChain: this.keychain.commonKeyChain,
      }
    };
    return keyObj;
  }

  encrypt(password: string, opts?: { iter?: number; ks?: number }) {
    if (!this.isPrivKeyEncrypted()) {
      super.encrypt(password, opts);
    } else if (!this.checkPassword(password)) {
      throw new Error('Private key is already encrypted but with a different password');
    }
    if (this.isKeyChainEncrypted()) {
      throw new Error('Keychain is already encrypted');
    }
    this.keychain.privateKeyShareEncrypted = JSON.stringify(Encryption.encryptWithPassword(this.keychain.privateKeyShare, password, opts));
    this.keychain.reducedPrivateKeyShareEncrypted = JSON.stringify(Encryption.encryptWithPassword(this.keychain.reducedPrivateKeyShare, password, opts));
    // remove the private data
    this.keychain.privateKeyShare.fill(0);
    this.keychain.privateKeyShare = null;
    this.keychain.reducedPrivateKeyShare.fill(0);
    this.keychain.reducedPrivateKeyShare = null;
  }

  decrypt(password: string) {
    try {
      super.decrypt(password);
    } catch (e) {
      if (e.message !== 'Private key is not encrypted') {
        throw e;
      }
    }
    if (this.isKeyChainEncrypted()) {
      this.keychain.privateKeyShare = Encryption.decryptWithPassword(this.keychain.privateKeyShareEncrypted, password);
      this.keychain.reducedPrivateKeyShare = Encryption.decryptWithPassword(this.keychain.reducedPrivateKeyShareEncrypted, password);
      // remove the encrypted data
      this.keychain.privateKeyShareEncrypted = null;
      this.keychain.reducedPrivateKeyShareEncrypted = null;
    }
  }

  /** `members` must only contain identities verified during the key generation ceremony */
  async createWalletForChain(params: {
    baseUrl: string;
    chain: string;
    coin?: string;
    network: 'livenet' | 'testnet' | 'regtest';
    walletName: string;
    copayerName: string;
    members: TssKeyMember[];
    roster?: TssKeyRoster;
    password?: PasswordMaybe;
    /** For testing only */
    request?: any;
  }): Promise<{ client: Client; wallet: any }> {
    const { baseUrl, chain, coin, network, walletName, copayerName, members, roster, password, request } = params;
    $.checkArgument(Constants.EVM_CHAINS.includes(chain), 'Invalid chain: TSS key wallets can only be added for EVM chains');

    const credentials = this.createCredentials(password, { chain, coin, network, account: 0 });
    const client = new Client({ baseUrl, request });
    client.fromObj(credentials.toObj());
    const { wallet } = await client.createWallet(walletName, copayerName, this.metadata.m, this.metadata.n, {
      chain,
      coin,
      network,
      tssKeyId: this.metadata.id
    });
    await TssKey.inviteMembers({ client, members, roster });
    return { client, wallet };
  }

  async joinWalletFromInvite(params: {
    baseUrl: string;
    wallet: TssKeyWallet;
    copayerName: string;
    members: TssKeyMember[];
    creatorPubKey: string;
    password?: PasswordMaybe;
    /** For testing only */
    request?: any;
  }): Promise<{ client: Client; wallet: any; roster?: TssKeyRoster }> {
    const { baseUrl, wallet, copayerName, members, creatorPubKey, password, request } = params;
    $.checkArgument(wallet?.invite, 'Missing TSS wallet invite');
    $.checkArgument(Constants.EVM_CHAINS.includes(wallet.chain), 'Invalid chain: TSS key wallets can only be added for EVM chains');

    const { senderRequestPubKey, encryptedSecret } = wallet.invite;
    const credentials = this.createCredentials(password, { chain: wallet.chain, coin: wallet.coin, network: wallet.network, account: 0 });
    const { secret, roster } = JSON.parse(ECIES.decrypt({
      payload: Buffer.from(encryptedSecret, 'base64'),
      privateKey: credentials.requestPrivKey,
      publicKey: senderRequestPubKey
    }).toString());

    const verifiedRoster: TssKeyRoster = TssKey.verifyRoster({ roster, tssKeyId: this.metadata.id, creatorPubKey }) ? roster : undefined;
    const verifiedMembers = [...members, ...(verifiedRoster?.members || [])];
    $.checkState(verifiedMembers.some(member => member.requestPubKey === senderRequestPubKey), 'Failed state: TSS wallet invite sender is not a verified member');
    $.checkState(Client.parseSecret(secret).walletId === wallet.id, 'Failed state: TSS wallet invite does not match the wallet');

    const client = new Client({ baseUrl, request });
    client.fromObj(credentials.toObj());
    const joinedWallet = await client.joinWallet(secret, copayerName, { chain: wallet.chain, coin: wallet.coin });
    $.checkState(joinedWallet.tssKeyId === this.metadata.id, 'Failed state: TSS key id mismatch at <joinWalletFromInvite()>');
    return { client, wallet: joinedWallet, roster: verifiedRoster };
  }

  static async inviteMembers(params: { client: Client; members: TssKeyMember[]; roster?: TssKeyRoster }): Promise<number> {
    const { client, members, roster } = params;
    const c = client.credentials;
    $.checkState(c.walletId && c.walletPrivKey, 'Failed state: wallet secret not available at <inviteMembers()>');

    const message = JSON.stringify({ secret: Client._buildSecret(c.walletId, c.walletPrivKey, c.coin, c.network), roster });
    const invites = members
      .filter(member => member.requestPubKey !== c.requestPubKey)
      .map(member => ({
        requestPubKey: member.requestPubKey,
        encryptedSecret: ECIES.encrypt({
          message,
          publicKey: member.requestPubKey,
          privateKey: c.requestPrivKey,
          opts: { noKey: true }
        }).toString('base64')
      }));
    if (invites.length) {
      await client.addTssWalletInvites(invites);
    }
    return invites.length;
  }

  createRoster(members: TssKeyMember[], password?: PasswordMaybe): TssKeyRoster {
    $.checkState(this.metadata.partyId === 0, 'Failed state: only the TSS key creator can sign the roster');
    const sortedMembers = [...members].sort((a, b) => a.partyId - b.partyId);
    const requestPrivKey = this.derive(password, Constants.PATHS.REQUEST_KEY).privateKey;
    return {
      tssKeyId: this.metadata.id,
      members: sortedMembers,
      signature: Utils.signMessage(TssKey.getRosterMessage(this.metadata.id, sortedMembers), requestPrivKey)
    };
  }

  static verifyRoster(params: { roster: TssKeyRoster; tssKeyId: string; creatorPubKey: string }): boolean {
    const { roster, tssKeyId, creatorPubKey } = params;
    if (roster?.tssKeyId !== tssKeyId || !Array.isArray(roster.members) || typeof roster.signature !== 'string') {
      return false;
    }
    try {
      return Utils.verifyMessage(TssKey.getRosterMessage(tssKeyId, roster.members), roster.signature, creatorPubKey);
    } catch {
      return false;
    }
  }

  static getRosterMessage(tssKeyId: string, members: TssKeyMember[]): string {
    return [tssKeyId, ...members.map(member => `${member.partyId}:${member.requestPubKey}`)].join('|');
  }
};

export class TssKeyGen extends EventEmitter {
  #request: Request;
  #key: Key;
  #xPrivKey: string;
  #keygen: ECDSA.KeyGen;
  #seed: string;
  #credentials: Credentials;
  #requestPrivateKey: BitcoreLib.PrivateKey;
  #subscriptionId: ReturnType<typeof setInterval>;
  #subscriptionRunning: boolean;
  id: string;
  chain: string;
  network: 'livenet' | 'testnet' | 'regtest';
  m: number;
  n: number;
  partyId: number;
  /** Request public key of the session creator, taken from the join code. Only set for joining parties */
  creatorPubKey: string;
  backupKeyShare: boolean;


  /**
   * Threshold Signature Scheme (TSS) client class
   */
  constructor(
    /** Constructor parameters */
    params: ITssKeyGenConstructorParams,
    /** EventEmitter options object */
    eventOpts?
  ) {
    super(eventOpts);
    $.checkArgument(params.chain, 'Missing required param: chain');
    $.checkArgument(params.network, 'Missing required param: network');
    $.checkArgument(params.baseUrl, 'Missing required param: baseUrl');
    $.checkArgument(params.key, 'Missing required param: key');
    $.checkArgument(params.key instanceof Key, 'key must be an instance of Key');

    this.chain = params.chain.toLowerCase();
    this.network = params.network;
    this.#request = new Request(params.baseUrl, {
      r: params.request, // For testing only
    });

    this.#key = params.key;
    // n is always 1 when creating credentials because the wallet is not multisig (threshold sig !== multisig).
    // In other words, it will look like a single sig wallet on-chain.
    this.#credentials = this.#key.createCredentials(params.password, { chain: this.chain, network: this.network, n: 1, account: 0 });
    this.#request.setCredentials(this.#credentials);
    this.#requestPrivateKey = BitcoreLib.PrivateKey.fromString(this.#credentials.requestPrivKey);

    const baseXPrivKey = this.#key.get(params.password).xPrivKey;
    const derivationPath = this.#credentials.getRootPath();
    this.#xPrivKey = new BitcoreLib.HDPrivateKey(baseXPrivKey).deriveChild(derivationPath).toString();
    const _seed = BitcoreLib.HDPrivateKey.fromString(this.#xPrivKey);
    this.#seed = BitcoreLib.crypto.Hash.sha256(_seed.toBuffer());

    // Backup to server is disabled
    // this.backupKeyShare = !!params.backupKeyShare;
  }

  /**
   * Initiate a new Threshold Signature Scheme key generation session
   * @returns {Promise<TssKeyGen>}
   */
  async newKey(params: {
    /**
     * Number of required signatures
     */
    m: number | string;
    /**
     * Number of parties/signers
     */
    n: number | string;
    /**
     * An optional password other parties must provide in order to join the session on the server.
     * This adds a layer of server-side security beyond the client-side-only join code.
     */
    password?: string;
  }): Promise<TssKeyGen> {
    const { m, n, password } = params;
    const keygen = new ECDSA.KeyGen({
      n,
      m,
      partyId: 0, // the session initiator is always partyId 0
      seed: this.#seed,
      authKey: this.#credentials.requestPrivKey
    });
    this.id = BitcoreLib.crypto.Hash.sha256sha256(this.#seed).toString('hex');
    this.m = parseInt(m as string);
    this.n = parseInt(n as string);
    this.partyId = 0;

    const msg = await keygen.initJoin();
    await this.#request.post('/v1/tss/keygen/' + this.id, { message: msg, n, password, version: TSS_KEYGEN_VERSION });
    this.#keygen = keygen;
    return this;
  }

  /**
   * Get the public key used for authentication. Each joining party will need
   * to provide this to the session initiator in order to join the TSS key.
   * @returns {string} The public key used for session authentication
   */
  getAuthPublicKey(): string {
    return this.#credentials.requestPubKey;
  }

  /**
   * Create a join code for a party to join the TSS key.
   * The join code is encrypted with the party's public key and is thus party-specific.
   * Note that the join code is verified on the client side only. Someone could theoretically
   *  intercept or brute force the session ID and submit an initial message to join the session
   *  uninvited. To prevent this (unlikely) possibility, set a password in the newKey() method
   *  and share it with the other parties.
   * @returns {string} Encrypted join code
   */
  createJoinCode(params: {
    /**
     * Party ID to create the join code for
     */
    partyId: number;
    /**
     * Public key of the party to encrypt the join code to
     */
    partyPubKey: string;
    /**
     * Extra data to include in the join code
     */
    extra?: string;
    /**
     * Options for the join code. Also contains opts for the ECIES.encrypt method
     */
    opts?: {
      /**
       * Encoding for the join code (default: 'hex')
       */
      encoding?: BufferEncoding;
      /**
       * ECIES.encrypt: Don't include the public key in the result
       */
      noKey?: boolean;
    };
  }): string {
    const { partyId, partyPubKey, opts } = params;
    const extra = params.extra || '';
    const data = [this.id, partyId, this.chain, this.network, this.m, this.n, extra].join(':');
    const code = ECIES.encrypt({
      message: data,
      publicKey: partyPubKey,
      privateKey: this.#requestPrivateKey,
      opts
    });
    return code.toString(opts?.encoding || 'hex');
  }

  checkJoinCode(params: {
    code: string | Buffer;
    opts?: {
      /**
       * Encoding for the join code (default: 'hex')
       */
      encoding?: BufferEncoding;
    };
  }) {
    let { code } = params;
    const { opts } = params;
    $.checkArgument(code, 'Missing required param: code');
    $.checkArgument(typeof code === 'string' || Buffer.isBuffer(code), '`code` must be a string or buffer');
    code = Buffer.isBuffer(code) ? code : Buffer.from(code, opts?.encoding || 'hex');
    const authKey = this.#credentials.requestPrivKey;
    const decryptedCode = ECIES.decrypt({ payload: code, privateKey: authKey }).toString();
    const [id, partyId, chain, network, m, n] = decryptedCode.split(':');
    return {
      id,
      partyId: parseInt(partyId),
      chain,
      network,
      m: parseInt(m),
      n: parseInt(n),
      creatorPubKey: getJoinCodeCreatorPubKey(code),
    };
  }

  /**
   * Join a Threshold Signature Scheme key
   */
  async joinKey(params: {
    /**
     * Join code given by the session initiator
     */
    code: string | Buffer;
    /**
     * Options for the join code. Also contains opts for the ECIES.decrypt method
     */
    opts?: {
      /**
       * Encoding for the join code (default: 'hex')
       */
      encoding?: BufferEncoding;
    };
    /**
     * Server password to join the TSS key. This was set by the initiator and should be told to you by them.
     */
    password?: string;
  }): Promise<TssKeyGen> {
    let { code, password } = params;
    const { opts } = params;
    $.checkArgument(code, 'Missing required param: code');
    $.checkArgument(typeof code === 'string' || Buffer.isBuffer(code), '`code` must be a string or buffer');

    code = Buffer.isBuffer(code) ? code : Buffer.from(code, opts?.encoding || 'hex');

    const authKey = this.#credentials.requestPrivKey;
    const decryptedCode = ECIES.decrypt({ payload: code, privateKey: authKey }).toString();
    const [id, partyId, chain, network, m, n, ...more] = decryptedCode.split(':');
    const extra = more.join(':');

    const keygen = new ECDSA.KeyGen({
      m,
      n,
      partyId,
      seed: this.#seed,
      authKey
    });

    this.#keygen = keygen;
    this.id = id;
    this.chain = chain;
    this.network = network;
    this.m = parseInt(m);
    this.n = parseInt(n);
    this.partyId = parseInt(partyId);
    this.creatorPubKey = getJoinCodeCreatorPubKey(code);

    const msg = await keygen.initJoin();
    password = password || extra;
    await this.#request.post('/v1/tss/keygen/' + this.id, { message: msg, password, version: TSS_KEYGEN_VERSION });
    return this;
  }

  /**
   * Export the session for storage
   * @returns {string} Session string
   */
  exportSession(): string {
    if (this.#keygen.isKeyChainReady()) {
      throw new Error('Cannot export a completed session. Run getKeyChain() instead.');
    }
    return [this.id, this.partyId, this.m, this.n, this.#keygen.export()].join(':');
  }

  /**
   * Restore a session from a previously exported session
   * @returns {Promise<TssKeyGen>} Restored TSS instance
   */
  async restoreSession(params: {
    /**
     * Session string to restore
     */
    session: string;
  }): Promise<TssKeyGen> {
    const { session } = params;
    const parts = session.split(':');
    const id = parts.slice(0, -4).join(':'); // id may contain colons, so we join all parts except the last 4
    const [partyId, m, n, keygenSession] = parts.slice(-4);
    this.id = id;
    this.m = parseInt(m);
    this.n = parseInt(n);
    this.partyId = parseInt(partyId);
    const keygen = await ECDSA.KeyGen.restore({ session: keygenSession, authKey: this.#credentials.requestPrivKey });
    this.#keygen = keygen;
    return this;
  }

  /**
   * Subscribe to the TSS key generation process + wallet creation
   * Various events will be emitted during the process:
   * - `roundready` => number: A new round is ready to be processed. Emits the round number.
   * - `roundprocessed` => number: A round has been processed. Emits the round number.
   * - `roundsubmitted` => number: A round has been submitted to the server. Emits the round number.
   * - `tsskey` => TssKey: The TSS key is ready. Emits the key class object.
   * - `tsskeystored`: => void: The TSS pub key and keyshare backup has been stored on the server.
   * - `wallet` => any: The wallet has been created. Emits the wallet object.
   * - `complete` => void: The key generation process (+ wallet creation, if applicable) is complete. This is the final event emitted along the happy path.
   * - `error` => Error: An error occurred during the process. Emits the error. Note that this will not stop the subscription.
   * @returns {NodeJS.Timeout} Subscription ID
   */
  subscribe(params: {
    /**
     * Timeout in milliseconds for the subscription to check for new messages (default: 1000)
     * @default 1000
     */
    timeout?: number;
    /**
     * Custom function to fire every iteration. Does not fire on error.
     */
    iterHandler?: () => void;
    /**
     * Name of the wallet to create.
     * Only provied by party 0 (the session initiator).
     */
    walletName?: string;
    /**
     * Name of the party/copayer. This is used to identify the party in the wallet (e.g. "Evan", "Sara Smith", etc.).
     * If given, the wallet will be automatically created/joined at BWS after the key generation is complete.
     * Omit if you wish to only generate the TSS key and not create the wallet.
     */
    copayerName?: string;
    /**
     * Options to pass to createWallet() when the key generation is complete.
     * Only provided by party 0 (the session initiator).
     */
    createWalletOpts?: CreateWalletOpts;
  } = {}): NodeJS.Timeout {
    const { timeout, iterHandler, walletName, copayerName, createWalletOpts } = params;
    $.checkArgument(
      this.partyId > 0 || 
      (this.partyId === 0 &&
        // (party0 only) walletName and copayerName must be supplied together or not at all
        ((walletName == null && copayerName == null) || 
        (walletName && copayerName))
      ),
      'Both the walletName and copayerName must be provided if you wish to create the wallet in subscribe().'
    );

    const complete = () => {
      this.emit('complete');
      if (iterHandler) iterHandler();
      this.unsubscribe();
      // Anything after unsubscribe() will not be executed
    };

    this.#subscriptionId = setInterval(async () => {
      if (this.#subscriptionRunning) return;
      this.#subscriptionRunning = true;
      try {
        const thisRound = this.#keygen.getRound();
        const prevRound = thisRound - 1; // Get previous round's messages
        const { body } = await this.#request.get(`/v1/tss/keygen/${this.id}/${prevRound}`) as RequestResponse;

        const hasEveryoneSubmitted = body.messages?.length === this.n - 1; // subtract yourself
        if (hasEveryoneSubmitted) {
          this.emit('roundready', thisRound);
          // Snapshot the session in case there's an API failure
          //  since this.#keygen can't re-process the messages
          const sessionBak = this.exportSession();
          try {
            const msg = await this.#keygen.nextRound(body.messages);
            this.emit('roundprocessed', thisRound);
            // If the keychain is ready, there's nothing to send to the server and msg will have empty arrays.
            if (!this.#keygen.isKeyChainReady()) {
              // For 2 P2P messages (i.e. party of 3), it already exceeds 100 KB (190 KB)
              // Assuming ~80KB per message, the max server size of 2MB would be ~25 P2P messages
              await this.#request.post(`/v1/tss/keygen/${this.id}`, { message: msg, version: TSS_KEYGEN_VERSION });
              this.emit('roundsubmitted', thisRound);
            }
          } catch (err) {
            // Restore the session to the previous state
            await this.restoreSession({ session: sessionBak });
            throw err;
          }
        }

        const key = this.getTssKey();
        if (key) {
          this.emit('tsskey', key);
          
          // Backup to server is disabled
          if (!body.publicKey) {// || (!body.hasKeyBackup && this.backupKeyShare)) {
            // const encryptedKeyChain = ECIES.encrypt({
            //   message: key.keychain.privateKeyShare.toString('base64') + ':' + key.keychain.reducedPrivateKeyShare.toString('base64'),
            //   publicKey: new BitcoreLib.HDPrivateKey(this.#xPrivKey).publicKey,
            //   privateKey: new BitcoreLib.HDPrivateKey(this.#xPrivKey).privateKey,
            //   opts: { noKey: true }
            // }).toString('base64');
            // await this.#request.post(`/v1/tss/keygen/${this.id}/store`, { publicKey: key.keychain.commonKeyChain, encryptedKeyChain });
            await this.#request.post(`/v1/tss/keygen/${this.id}/store`, { publicKey: key.keychain.commonKeyChain });
            this.emit('tsskeystored');
          }

          if (!copayerName) {
            complete();
            // Anything after complete()/unsubscribe() will not be executed
          } else {
            let wallet;
            if (this.partyId === 0) {
              wallet = await this.createWallet({
                walletName,
                copayerName,
                opts: createWalletOpts
              });
            } else if (this.partyId > 0) {
              try {
                wallet = await this.joinWallet({ copayerName });
              } catch (err) {
                if (!err.message.includes('TSS_BWS_JOIN_SECRET_NOT_FOUND')) {
                  throw err;
                }
                // Ignore 'No secret found...' since it means the session initiator has not finished created the wallet yet
              }
            }
          
            if (wallet) {
              this.emit('wallet', wallet);
              complete();
              // Anything after complete()/unsubscribe() will not be executed
            }
          }
        }
        // iteration handler
        // Some custom function to fire every iteration
        if (iterHandler) iterHandler();
      } catch (err) {
        this.emit('error', err);
      } finally {
        this.#subscriptionRunning = false;
      }
    }, timeout || 1000);

    return this.#subscriptionId;
  }

  /**
   * Unsubscribe from the TSS key generation process
   * Calling this method will emit the 'unsubscribe' event.
   */
  unsubscribe(params: {
    /**
     * Whether to remove all event listeners
     * @default true
     */
    clearEvents: boolean;
  } = { clearEvents: true }): void {
    const { clearEvents } = params;
    clearInterval(this.#subscriptionId);
    if (clearEvents) {
      this.removeAllListeners();
    }
    this.#subscriptionId = null;
    this.#subscriptionRunning = false;
    this.emit('unsubscribe');
  }

  /**
   * Get the key object if the key generation process is complete
   * @returns {TssKey|null} The keychain object if the key generation process is complete, otherwise null
   */
  getTssKey(password?: PasswordMaybe): TssKey | null {
    if (this.#keygen.isKeyChainReady()) {
      const keychain = this.#keygen.getKeyChain();
      const key = new TssKey({
        ...this.#key.toObj(),
        keychain: { ...keychain },
        metadata: {
          id: this.id,
          m: this.m,
          n: this.n,
          partyId: this.partyId
        }
      });
      if (password) {
        key.encrypt(password);
      }
      return key;
    }
    return null;
  }

  async createWallet(params: {
    walletName: string;
    copayerName: string;
    opts?: CreateWalletOpts & { addressType?: string };
  }) {
    const { walletName, copayerName, opts = {} } = params;
    const key = this.getTssKey();
    if (!key) {
      throw new Error('TSS Key generation is not complete. This should be called after the `complete` event is emitted.');
    }
    this.#credentials.clientDerivedPublicKey = key.getXPubKey(this.network);

    const client = new Client({ baseUrl: this.#request.baseUrl });
    client.fromObj(this.#credentials.toObj());

    const { wallet, secret } = await client.createWallet(
      walletName,
      copayerName,
      key.metadata.m,
      key.metadata.n,
      Object.assign({}, opts, {
        tssKeyId: this.id,
        chain: this.chain,
        network: this.network,
      })
    );

    await this.#request.post(`/v1/tss/keygen/${this.id}/secret`, { secret });
    const credObj = client.toObj();
    this.#credentials.addWalletInfo(credObj.walletId, walletName, 1, 1, copayerName, {
      useNativeSegwit: ['P2WPKH', 'P2WSH', 'P2TR'].includes(wallet.addressType),
      segwitVersion: wallet.addressType === 'P2TR' ? 1 : 0,
      tssKeyId: this.id,
    });
    return wallet;
  }

  async joinWallet(params: {
    copayerName: string;
    opts?: {
      coin?: string;
      dryRun?: boolean;
    };
  }) {
    const { copayerName, opts = {} } = params;
    const key = this.getTssKey();
    if (!key) {
      throw new Error('TSS Key generation is not complete. This should be called after the `complete` event is emitted.');
    }
    this.#credentials.clientDerivedPublicKey = key.getXPubKey(this.network);

    const { body: { secret } } = await this.#request.get(`/v1/tss/keygen/${this.id}/secret`);

    const client = new Client({ baseUrl: this.#request.baseUrl });
    client.fromObj(this.#credentials.toObj());

    const wallet = await client.joinWallet(
      secret,
      copayerName,
      Object.assign({}, opts, {
        chain: this.chain
      })
    );

    const credObj = client.toObj();
    this.#credentials.addWalletInfo(credObj.walletId, credObj.walletName, 1, 1, copayerName, {
      useNativeSegwit: ['P2WPKH', 'P2WSH', 'P2TR'].includes(wallet.addressType),
      segwitVersion: wallet.addressType === 'P2TR' ? 1 : 0,
      tssKeyId: this.id,
    });
    
    return wallet;
  }

  /**
   * Clean up sensitive data from memory.
   * Call this when you are done with the keygen session
   */
  cleanup() {
    this.#keygen?.cleanup();
  }
}