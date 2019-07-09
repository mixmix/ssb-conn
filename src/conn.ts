import ConnDB = require('ssb-conn-db');
import ConnHub = require('ssb-conn-hub');
import ConnStaging = require('ssb-conn-staging');
import ConnQuery = require('ssb-conn-query');
import {StagedData} from 'ssb-conn-staging/lib/types';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {Callback} from './types';
import {interpoolGlue} from './interpool-glue';
const msAddress = require('multiserver-address');
const ping = require('pull-ping');

@plugin('1.0.0')
export class CONN {
  private readonly ssb: any;
  private readonly config: any;
  private readonly db: ConnDB;
  private readonly hub: ConnHub;
  private readonly staging: ConnStaging;
  private readonly connQuery: ConnQuery;

  constructor(ssb: any, cfg: any) {
    this.ssb = ssb;
    this.config = cfg;
    this.db = new ConnDB({path: this.config.path, writeTimeout: 10e3});
    this.hub = new ConnHub(this.ssb);
    this.staging = new ConnStaging();
    this.connQuery = new ConnQuery(this.db, this.hub, this.staging);

    this.initialize();
  }

  //#region Initialization

  private initialize() {
    this.setupCloseHook();
    this.maybeAutoStartScheduler();
    interpoolGlue(this.db, this.hub, this.staging);
  }

  private setupCloseHook() {
    const that = this;
    this.ssb.close.hook(function(this: any, fn: Function, args: Array<any>) {
      that.stopScheduler();
      that.db.close();
      that.hub.close();
      that.staging.close();
      return fn.apply(this, args);
    });
  }

  private maybeAutoStartScheduler() {
    if (this.config.conn && this.config.conn.autostart !== false) {
      this.startScheduler();
    }
  }

  //#endregion

  //#region Helper methods

  private async startScheduler() {
    await this.db.loaded();

    if (this.ssb.connScheduler) {
      this.ssb.connScheduler.start();
    } else {
      // Maybe this is a race condition, so let's wait a bit more
      setTimeout(() => {
        if (this.ssb.connScheduler) {
          this.ssb.connScheduler.start();
        } else {
          console.error(
            'There is no ConnScheduler! ' +
              'The CONN plugin will remain in manual mode.',
          );
        }
      }, 100);
    }
  }

  private stopScheduler() {
    if (this.ssb.connScheduler) this.ssb.connScheduler.stop();
  }

  private assertValidAddress(address: string) {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
  }

  //#endregion

  //#region PUBLIC MUXRPC

  @muxrpc('sync')
  public remember = (address: string, data: any = {}) => {
    this.assertValidAddress(address);

    this.db.set(address, data);
  };

  @muxrpc('sync')
  public forget = (address: string) => {
    this.assertValidAddress(address);

    this.db.delete(address);
  };

  @muxrpc('sync')
  public dbPeers = () => this.db.entries();

  @muxrpc('async')
  public connect = (
    address: string,
    second: Record<string, any> | null | undefined | Callback<any>,
    third?: Callback<any>,
  ) => {
    if (typeof second === 'function' && typeof third === 'function') {
      throw new Error('CONN.connect() received incorrect arguments');
    }
    const cb = (typeof third === 'function' ? third : second) as Callback<any>;
    const data = (typeof third === 'function' ? second : undefined) as any;

    try {
      this.assertValidAddress(address);
    } catch (err) {
      cb(err);
      return;
    }

    this.hub
      .connect(address, data)
      .then(result => cb && cb(null, result), err => cb && cb(err));
  };

  @muxrpc('async')
  public disconnect = (address: string, cb: Callback<any>) => {
    try {
      this.assertValidAddress(address);
    } catch (err) {
      cb(err);
      return;
    }

    this.hub
      .disconnect(address)
      .then(result => cb && cb(null, result), err => cb && cb(err));
  };

  @muxrpc('source')
  public peers = () => this.hub.liveEntries();

  @muxrpc('sync')
  public stage = (
    address: string,
    data: Partial<StagedData> = {type: 'internet'},
  ) => {
    if (!!this.hub.getState(address)) return false;

    return this.staging.stage(address, data);
  };

  @muxrpc('sync')
  public unstage = (address: string) => {
    return this.staging.unstage(address);
  };

  @muxrpc('source')
  public stagedPeers = () => this.staging.liveEntries();

  @muxrpc('sync')
  public query = () => this.connQuery;

  @muxrpc('sync')
  public start = () => {
    return this.startScheduler();
  };

  @muxrpc('sync')
  public stop = () => {
    this.stopScheduler();
  };

  @muxrpc('duplex', {anonymous: 'allow'})
  public ping = () => {
    const MIN = 10e3;
    const DEFAULT = 5 * 60e3;
    const MAX = 30 * 60e3;
    let timeout = (this.config.timers && this.config.timers.ping) || DEFAULT;
    timeout = Math.max(MIN, Math.min(timeout, MAX));
    return ping({timeout});
  };

  @muxrpc('sync')
  public internalConnDB = () => this.db;

  @muxrpc('sync')
  public internalConnHub = () => this.hub;

  @muxrpc('sync')
  public internalConnStaging = () => this.staging;

  //#endregion
}
