import logger from '../../../logger';
import { EthP2pWorker } from './p2p';
import { IVerificationPeer } from '../../../services/verification';
import { EthBlockStorage } from '../models/block';

export class EthVerificationPeer extends EthP2pWorker implements IVerificationPeer {
  async setupListeners() {
    this.txSubscription = await this.web3!.eth.subscribe('pendingTransactions');
    this.txSubscription.subscribe((_err, tx) => {
      this.events.emit('transaction', tx);
    });
    this.blockSubscription = await this.web3!.eth.subscribe('newBlockHeaders');
    this.blockSubscription.subscribe((_err, block) => {
      this.events.emit('block', block);
    });
  }

  async resync(from: number, to: number) {
    const { chain, network } = this;
    let currentHeight = Math.max(1, from);
    while (currentHeight < to) {
      let lastLog = Date.now();
      const block = await this.getBlock(currentHeight);
      if (currentHeight > to) {
        break;
      }
      const { convertedBlock, convertedTxs } = await this.convertBlock(block);

      const nextBlock = await EthBlockStorage.collection.findOne({ chain, network, previousBlockHash: block.hash });
      if (nextBlock) {
        convertedBlock.nextBlockHash = nextBlock.hash;
      }

      await this.blockModel.processBlock({
        chain: this.chain,
        network: this.network,
        forkHeight: this.chainConfig.forkHeight,
        parentChain: this.chainConfig.parentChain,
        initialSyncComplete: this.initialSyncComplete,
        block: convertedBlock,
        transactions: convertedTxs
      });

      currentHeight++;

      if (Date.now() - lastLog > 100) {
        logger.info(`Re-Sync `, {
          chain,
          network,
          height: currentHeight
        });
        lastLog = Date.now();
      }
    }
  }

  async getBlockForNumber(blockNum: number) {
    return this.getBlock(blockNum);
  }
}
