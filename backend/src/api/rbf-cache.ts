import config from "../config";
import logger from "../logger";
import { TransactionExtended, TransactionStripped } from "../mempool.interfaces";
import bitcoinApi from './bitcoin/bitcoin-api-factory';
import { Common } from "./common";
import redisCache from "./redis-cache";

export interface RbfTransaction extends TransactionStripped {
  rbf?: boolean;
  mined?: boolean;
}

export interface RbfTree {
  tx: RbfTransaction;
  time: number;
  interval?: number;
  mined?: boolean;
  fullRbf: boolean;
  replaces: RbfTree[];
}

enum CacheOp {
  Remove = 0,
  Add = 1,
  Change = 2,
}

interface CacheEvent {
  op: CacheOp;
  type: 'tx' | 'tree' | 'exp';
  txid: string,
  value?: any,
}

class RbfCache {
  private replacedBy: Map<string, string> = new Map();
  private replaces: Map<string, string[]> = new Map();
  private rbfTrees: Map<string, RbfTree> = new Map(); // sequences of consecutive replacements
  private dirtyTrees: Set<string> = new Set();
  private treeMap: Map<string, string> = new Map(); // map of txids to sequence ids
  private txs: Map<string, TransactionExtended> = new Map();
  private expiring: Map<string, number> = new Map();
  private cacheQueue: CacheEvent[] = [];

  constructor() {
    setInterval(this.cleanup.bind(this), 1000 * 60 * 10);
  }

  private addTx(txid: string, tx: TransactionExtended): void {
    this.txs.set(txid, tx);
    this.cacheQueue.push({ op: CacheOp.Add, type: 'tx', txid });
  }

  private addTree(txid: string, tree: RbfTree): void {
    this.rbfTrees.set(txid, tree);
    this.dirtyTrees.add(txid);
    this.cacheQueue.push({ op: CacheOp.Add, type: 'tree', txid });
  }

  private addExpiration(txid: string, expiry: number): void {
    this.expiring.set(txid, expiry);
    this.cacheQueue.push({ op: CacheOp.Add, type: 'exp', txid, value: expiry });
  }

  private removeTx(txid: string): void {
    this.txs.delete(txid);
    this.cacheQueue.push({ op: CacheOp.Remove, type: 'tx', txid });
  }

  private removeTree(txid: string): void {
    this.rbfTrees.delete(txid);
    this.cacheQueue.push({ op: CacheOp.Remove, type: 'tree', txid });
  }

  private removeExpiration(txid: string): void {
    this.expiring.delete(txid);
    this.cacheQueue.push({ op: CacheOp.Remove, type: 'exp', txid });
  }

  public add(replaced: TransactionExtended[], newTxExtended: TransactionExtended): void {
    if (!newTxExtended || !replaced?.length) {
      return;
    }

    const newTx = Common.stripTransaction(newTxExtended) as RbfTransaction;
    const newTime = newTxExtended.firstSeen || (Date.now() / 1000);
    newTx.rbf = newTxExtended.vin.some((v) => v.sequence < 0xfffffffe);
    this.addTx(newTx.txid, newTxExtended);

    // maintain rbf trees
    let fullRbf = false;
    const replacedTrees: RbfTree[] = [];
    for (const replacedTxExtended of replaced) {
      const replacedTx = Common.stripTransaction(replacedTxExtended) as RbfTransaction;
      replacedTx.rbf = replacedTxExtended.vin.some((v) => v.sequence < 0xfffffffe);
      this.replacedBy.set(replacedTx.txid, newTx.txid);
      if (this.treeMap.has(replacedTx.txid)) {
        const treeId = this.treeMap.get(replacedTx.txid);
        if (treeId) {
          const tree = this.rbfTrees.get(treeId);
          this.removeTree(treeId);
          if (tree) {
            tree.interval = newTime - tree?.time;
            replacedTrees.push(tree);
            fullRbf = fullRbf || tree.fullRbf;
          }
        }
      } else {
        const replacedTime = replacedTxExtended.firstSeen || (Date.now() / 1000);
        replacedTrees.push({
          tx: replacedTx,
          time: replacedTime,
          interval: newTime - replacedTime,
          fullRbf: !replacedTx.rbf,
          replaces: [],
        });
        fullRbf = fullRbf || !replacedTx.rbf;
        this.addTx(replacedTx.txid, replacedTxExtended);
      }
    }
    const treeId = replacedTrees[0].tx.txid;
    const newTree = {
      tx: newTx,
      time: newTime,
      fullRbf,
      replaces: replacedTrees
    };
    this.addTree(treeId, newTree);
    this.updateTreeMap(treeId, newTree);
    this.replaces.set(newTx.txid, replacedTrees.map(tree => tree.tx.txid));
  }

  public getReplacedBy(txId: string): string | undefined {
    return this.replacedBy.get(txId);
  }

  public getReplaces(txId: string): string[] | undefined {
    return this.replaces.get(txId);
  }

  public getTx(txId: string): TransactionExtended | undefined {
    return this.txs.get(txId);
  }

  public getRbfTree(txId: string): RbfTree | void {
    return this.rbfTrees.get(this.treeMap.get(txId) || '');
  }

  // get a paginated list of RbfTrees
  // ordered by most recent replacement time
  public getRbfTrees(onlyFullRbf: boolean, after?: string): RbfTree[] {
    const limit = 25;
    const trees: RbfTree[] = [];
    const used = new Set<string>();
    const replacements: string[][] = Array.from(this.replacedBy).reverse();
    const afterTree = after ? this.treeMap.get(after) : null;
    let ready = !afterTree;
    for (let i = 0; i < replacements.length && trees.length <= limit - 1; i++) {
      const txid = replacements[i][1];
      const treeId = this.treeMap.get(txid) || '';
      if (treeId === afterTree) {
        ready = true;
      } else if (ready) {
        if (!used.has(treeId)) {
          const tree = this.rbfTrees.get(treeId);
          used.add(treeId);
          if (tree && (!onlyFullRbf || tree.fullRbf)) {
            trees.push(tree);
          }
        }
      }
    }
    return trees;
  }

  // get map of rbf trees that have been updated since the last call
  public getRbfChanges(): { trees: {[id: string]: RbfTree }, map: { [txid: string]: string }} {
    const changes: { trees: {[id: string]: RbfTree }, map: { [txid: string]: string }} = {
      trees: {},
      map: {},
    };
    this.dirtyTrees.forEach(id => {
      const tree = this.rbfTrees.get(id);
      if (tree) {
        changes.trees[id] = tree;
        this.getTransactionsInTree(tree).forEach(tx => {
          changes.map[tx.txid] = id;
        });
      }
    });
    this.dirtyTrees = new Set();
    return changes;
  }

  public mined(txid): void {
    if (!this.txs.has(txid)) {
      return;
    }
    const treeId = this.treeMap.get(txid);
    if (treeId && this.rbfTrees.has(treeId)) {
      const tree = this.rbfTrees.get(treeId);
      if (tree) {
        this.setTreeMined(tree, txid);
        tree.mined = true;
        this.dirtyTrees.add(treeId);
        this.cacheQueue.push({ op: CacheOp.Change, type: 'tree', txid: treeId });
      }
    }
    this.evict(txid);
  }

  // flag a transaction as removed from the mempool
  public evict(txid: string, fast: boolean = false): void {
    if (this.txs.has(txid) && (fast || !this.expiring.has(txid))) {
      const expiryTime = fast ? Date.now() + (1000 * 60 * 10) : Date.now() + (1000 * 86400); // 24 hours
      this.addExpiration(txid, expiryTime);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const txid of this.expiring.keys()) {
      if ((this.expiring.get(txid) || 0) < now) {
        this.removeExpiration(txid);
        this.remove(txid);
      }
    }
    logger.debug(`rbf cache contains ${this.txs.size} txs, ${this.rbfTrees.size} trees, ${this.expiring.size} due to expire`);
  }

  // remove a transaction & all previous versions from the cache
  private remove(txid): void {
    // don't remove a transaction if a newer version remains in the mempool
    if (!this.replacedBy.has(txid)) {
      const replaces = this.replaces.get(txid);
      this.replaces.delete(txid);
      this.treeMap.delete(txid);
      this.removeTx(txid);
      this.removeExpiration(txid);
      for (const tx of (replaces || [])) {
        // recursively remove prior versions from the cache
        this.replacedBy.delete(tx);
        // if this is the id of a tree, remove that too
        if (this.treeMap.get(tx) === tx) {
          this.removeTree(tx);
        }
        this.remove(tx);
      }
    }
  }

  private updateTreeMap(newId: string, tree: RbfTree): void {
    this.treeMap.set(tree.tx.txid, newId);
    tree.replaces.forEach(subtree => {
      this.updateTreeMap(newId, subtree);
    });
  }

  private getTransactionsInTree(tree: RbfTree, txs: RbfTransaction[] = []): RbfTransaction[] {
    txs.push(tree.tx);
    tree.replaces.forEach(subtree => {
      this.getTransactionsInTree(subtree, txs);
    });
    return txs;
  }

  private setTreeMined(tree: RbfTree, txid: string): void {
    if (tree.tx.txid === txid) {
      tree.tx.mined = true;
    } else {
      tree.replaces.forEach(subtree => {
        this.setTreeMined(subtree, txid);
      });
    }
  }

  public async updateCache(): Promise<void> {
    if (!config.REDIS.ENABLED) {
      return;
    }
    // Update the Redis cache by replaying queued events
    for (const e of this.cacheQueue) {
      if (e.op === CacheOp.Add || e.op === CacheOp.Change) {
        let value = e.value;
          switch(e.type) {
            case 'tx': {
              value = this.txs.get(e.txid);
            } break;
            case 'tree': {
              const tree = this.rbfTrees.get(e.txid);
              value = tree ? this.exportTree(tree) : null;
            } break;
          }
          if (value != null) {
            await redisCache.$setRbfEntry(e.type, e.txid, value);
          }
      } else if (e.op === CacheOp.Remove) {
        await redisCache.$removeRbfEntry(e.type, e.txid);
      }
    }
    this.cacheQueue = [];
  }

  public dump(): any {
    const trees = Array.from(this.rbfTrees.values()).map((tree: RbfTree) => { return this.exportTree(tree); });

    return {
      txs: Array.from(this.txs.entries()),
      trees,
      expiring: Array.from(this.expiring.entries()),
    };
  }

  public async load({ txs, trees, expiring }): Promise<void> {
    txs.forEach(txEntry => {
      this.txs.set(txEntry[0], txEntry[1]);
    });
    for (const deflatedTree of trees) {
      await this.importTree(deflatedTree.root, deflatedTree.root, deflatedTree, this.txs);
    }
    expiring.forEach(expiringEntry => {
      if (this.txs.has(expiringEntry[0])) {
        this.expiring.set(expiringEntry[0], new Date(expiringEntry[1]).getTime());
      }
    });
    this.cleanup();
  }

  exportTree(tree: RbfTree, deflated: any = null) {
    if (!deflated) {
      deflated = {
        root: tree.tx.txid,
      };
    }
    deflated[tree.tx.txid] = {
      tx: tree.tx.txid,
      txMined: tree.tx.mined,
      time: tree.time,
      interval: tree.interval,
      mined: tree.mined,
      fullRbf: tree.fullRbf,
      replaces: tree.replaces.map(child => child.tx.txid),
    };
    tree.replaces.forEach(child => {
      this.exportTree(child, deflated);
    });
    return deflated;
  }

  async importTree(root, txid, deflated, txs: Map<string, TransactionExtended>, mined: boolean = false): Promise<RbfTree | void> {
    const treeInfo = deflated[txid];
    const replaces: RbfTree[] = [];

    // check if any transactions in this tree have already been confirmed
    mined = mined || treeInfo.mined;
    let exists = mined;
    if (!mined) {
      try {
        const apiTx = await bitcoinApi.$getRawTransaction(txid);
        if (apiTx) {
          exists = true;
        }
        if (apiTx?.status?.confirmed) {
          mined = true;
          treeInfo.txMined = true;
          this.evict(txid, true);
        }
      } catch (e) {
        // most transactions do not exist
      }
    }

    // if the root tx is not in the mempool or the blockchain
    // evict this tree as soon as possible
    if (root === txid && !exists) {
      this.evict(txid, true);
    }

    // recursively reconstruct child trees
    for (const childId of treeInfo.replaces) {
      const replaced = await this.importTree(root, childId, deflated, txs, mined);
      if (replaced) {
        this.replacedBy.set(replaced.tx.txid, txid);
        replaces.push(replaced);
        if (replaced.mined) {
          mined = true;
        }
      }
    }
    this.replaces.set(txid, replaces.map(t => t.tx.txid));

    const tx = txs.get(txid);
    if (!tx) {
      return;
    }
    const strippedTx = Common.stripTransaction(tx) as RbfTransaction;
    strippedTx.rbf = tx.vin.some((v) => v.sequence < 0xfffffffe);
    strippedTx.mined = treeInfo.txMined;
    const tree = {
      tx: strippedTx,
      time: treeInfo.time,
      interval: treeInfo.interval,
      mined: mined,
      fullRbf: treeInfo.fullRbf,
      replaces,
    };
    this.treeMap.set(txid, root);
    if (root === txid) {
      this.addTree(root, tree);
    }
    return tree;
  }
}

export default new RbfCache();
