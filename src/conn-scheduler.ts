import ConnQuery = require('ssb-conn-query');
import {ListenEvent as HubEvent} from 'ssb-conn-hub/lib/types';
import {StagedData} from 'ssb-conn-staging/lib/types';
import {Peer} from 'ssb-conn-query/lib/types';
import {Discovery as LANDiscovery} from 'ssb-lan/lib/types';
import {Msg, FeedId} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {CONN} from './conn';
const pull = require('pull-stream');
const Pausable = require('pull-pause');
const ip = require('ip');
const onWakeup = require('on-wakeup');
const onNetwork = require('on-change-network');
const hasNetwork = require('has-network');
const Ref = require('ssb-ref');
const debug = require('debug')('ssb:conn:scheduler');
require('zii');

let lastCheck = 0;
let lastValue: any = null;
function hasNetworkDebounced() {
  if (lastCheck + 1e3 < Date.now()) {
    lastCheck = Date.now();
    lastValue = hasNetwork();
  }
  return lastValue;
}

//detect if not connected to wifi or other network
//(i.e. if there is only localhost)
function isOffline(p: Peer) {
  if (ip.isLoopback(p[1].host) || p[1].host == 'localhost') return false;
  else return !hasNetworkDebounced();
}

const canBeConnected = (p: Peer) => !isOffline(p);

function isLocal(p: Peer): boolean {
  // don't rely on private ip address, because
  // cjdns creates fake private ip addresses.
  // ignore localhost addresses, because sometimes they get broadcast.
  return (
    !ip.isLoopback(p[1].host) &&
    ip.isPrivate(p[1].host) &&
    (p[1].source === 'local' || p[1].type === 'lan')
  );
}

//peers which we can connect to, but are not upgraded.
//select peers which we can connect to, but are not upgraded to LT.
//assume any peer is legacy, until we know otherwise...
function isLegacy(peer: Peer): boolean {
  return hasSuccessfulAttempts(peer) && !hasPinged(peer);
}

function take(n: number) {
  return <T>(arr: Array<T>) => arr.slice(0, Math.max(n, 0));
}

const {
  passesExpBackoff,
  passesGroupDebounce,
  hasNoAttempts,
  hasOnlyFailedAttempts,
  hasPinged,
  hasSuccessfulAttempts,
  sortByStateChange,
} = ConnQuery;

function shufflePeers(peers: Array<Peer>) {
  return peers.sort(() => Math.random() - 0.5);
}

function neverJustOne(x: number) {
  if (x === 1) return x + 1;
  else return x;
}

const minute = 60e3;
const hour = 60 * 60e3;

type BTPeer = {remoteAddress: string; id: string; displayName: string};

@plugin('1.0.0')
export class ConnScheduler {
  private readonly ssb: {conn: CONN; [name: string]: any};
  private readonly config: any;
  private readonly hasSsbDb: boolean;
  private closed: boolean;
  private isLoadingHops: boolean;
  private lastMessageAt: number;
  private hasScheduledAnUpdate: boolean;
  private hops: Record<FeedId, number>;

  constructor(ssb: any, config: any) {
    this.ssb = ssb;
    this.config = config;
    this.hasSsbDb = !!this.ssb.post && !!this.ssb.messagesByType;
    this.closed = true;
    this.lastMessageAt = 0;
    this.hasScheduledAnUpdate = false;
    this.isLoadingHops = false;
    this.hops = {};

    if (this.hasSsbDb) {
      this.ssb.post((msg: Msg) => {
        if (msg.value.author != this.ssb.id) {
          this.lastMessageAt = Date.now();
        }
        if (msg.value.content && msg.value.content.type === 'contact') {
          this.loadHops(() => this.updateNow());
        }
      });
    }
  }

  private loadHops(doneCallback?: () => void) {
    if (!this.ssb.friends || !this.ssb.friends.hops) {
      debug('Warning: ssb-friends is missing, scheduling will miss some info');
      return;
    }

    this.isLoadingHops = true;
    this.ssb.friends.hops((err: any, hops: Record<FeedId, number>) => {
      if (err) {
        debug('unable to call ssb.friends.hops: %s', err);
        return;
      }
      this.hops = hops;
      this.isLoadingHops = false;
      if (doneCallback) doneCallback();
    });
  }

  // Utility to pick from config, with some defaults
  private conf(name: any, def: any) {
    if (this.config.gossip == null) return def;
    const value = this.config.gossip[name];
    return value == null || value === '' ? def : value;
  }

  private isCurrentlyDownloading() {
    // don't schedule new connections if currently downloading messages
    return this.lastMessageAt && this.lastMessageAt > Date.now() - 500;
  }

  private weBlockThem = ([_addr, data]: [string, {key?: string}]) => {
    if (!data || !data.key) return false;
    return this.hops[data.key] === -1;
  };

  private weFollowThem = ([_addr, data]: [string, {key?: string}]) => {
    if (!data || !data.key) return false;
    const h = this.hops[data.key];
    return h > 0 && h <= 1;
  };

  // Utility to connect to bunch of peers, or disconnect if over quota
  // opts: { quota, backoffStep, backoffMax, groupMin }
  private updateTheseConnections(test: (p: Peer) => boolean, opts: any) {
    const query = this.ssb.conn.query();
    const peersUp = query.peersInConnection().filter(test);
    const peersDown = query.peersConnectable('db').filter(test);
    const {quota, backoffStep, backoffMax, groupMin} = opts;
    const excess = peersUp.length > quota * 2 ? peersUp.length - quota : 0;
    const freeSlots = neverJustOne(Math.max(quota - peersUp.length, 0));

    // Disconnect from excess
    peersUp
      .z(sortByStateChange)
      .z(take(excess))
      .forEach(([addr]) => this.ssb.conn.disconnect(addr));

    // Connect to suitable candidates
    peersDown
      .filter(p => !this.weBlockThem(p))
      .filter(canBeConnected)
      .filter(([, data]) => data.autoconnect !== false)
      .z(passesGroupDebounce(groupMin))
      .filter(passesExpBackoff(backoffStep, backoffMax))
      .z(peers =>
        // with 30% chance, ignore 'bestness' and just choose randomly
        Math.random() <= 0.3
          ? peers.z(shufflePeers)
          : peers.z(sortByStateChange),
      )
      .z(take(freeSlots))
      .forEach(([addr, data]) => this.ssb.conn.connect(addr, data));
  }

  private updateStagingNow() {
    // Stage all db peers with autoconnect=false
    this.ssb.conn
      .query()
      .peersConnectable('db')
      .filter(p => !this.weBlockThem(p))
      .filter(([, data]) => data.autoconnect === false)
      .forEach(([addr, data]) => this.ssb.conn.stage(addr, data));

    // Purge staged peers that are now blocked
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(this.weBlockThem)
      .forEach(([addr]) => this.ssb.conn.unstage(addr));

    // Purge some old staged LAN peers
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(([, data]) => data.type === 'lan')
      .filter(([, data]) => data.stagingUpdated! + 10e3 < Date.now())
      .forEach(([addr]) => this.ssb.conn.unstage(addr));

    // Purge some old staged Bluetooth peers
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(([, data]) => data.type === 'bt')
      .filter(([, data]) => data.stagingUpdated! + 30e3 < Date.now())
      .forEach(([addr]) => this.ssb.conn.unstage(addr));
  }

  private updateHubNow() {
    if (this.conf('seed', true)) {
      this.updateTheseConnections(p => p[1].source === 'seed', {
        quota: 3,
        backoffStep: 2e3,
        backoffMax: 10 * minute,
        groupMin: 1e3,
      });
    }

    // If there are no peers, then try *any* connection ASAP
    if (this.ssb.conn.query().peersInConnection().length === 0) {
      this.updateTheseConnections(() => true, {
        quota: 1,
        backoffStep: 1e3,
        backoffMax: 6e3,
        groupMin: 0,
      });
    }

    // Connect to rooms, up to 10 of them, prioritized over pubs
    this.updateTheseConnections(p => p[1].type === 'room', {
      quota: 10,
      backoffStep: 5e3,
      backoffMax: 5 * minute,
      groupMin: 5e3,
    });

    this.updateTheseConnections(hasPinged, {
      quota: 2,
      backoffStep: 10e3,
      backoffMax: 10 * minute,
      groupMin: 5e3,
    });

    this.updateTheseConnections(hasNoAttempts, {
      quota: 2,
      backoffStep: 30e3,
      backoffMax: 30 * minute,
      groupMin: 15e3,
    });

    this.updateTheseConnections(hasOnlyFailedAttempts, {
      quota: 3,
      backoffStep: 1 * minute,
      backoffMax: 3 * hour,
      groupMin: 5 * minute,
    });

    this.updateTheseConnections(isLegacy, {
      quota: 1,
      backoffStep: 4 * minute,
      backoffMax: 3 * hour,
      groupMin: 5 * minute,
    });

    // Automatically connect to (five) staged peers we follow
    this.ssb.conn
      .query()
      .peersConnectable('staging')
      .filter(this.weFollowThem)
      .z(take(5))
      .forEach(([addr, data]) => this.ssb.conn.connect(addr, data));

    // Purge connected peers that are now blocked
    this.ssb.conn
      .query()
      .peersInConnection()
      .filter(this.weBlockThem)
      .forEach(([addr]) => this.ssb.conn.disconnect(addr));

    // Purge some ongoing frustrating connection attempts
    this.ssb.conn
      .query()
      .peersInConnection()
      .filter(peer => {
        const permanent = hasPinged(peer) || isLocal(peer);
        const state = this.ssb.conn.hub().getState(peer[0]);
        return !permanent || state === 'connecting';
      })
      .filter(peer => peer[1].stateChange! + 10e3 < Date.now())
      .forEach(([addr]) => this.ssb.conn.disconnect(addr));

    // Purge an internet connection after it has been up for 1h
    this.ssb.conn
      .query()
      .peersConnected()
      .filter(peer => peer[1].type !== 'bt' && peer[1].type !== 'lan')
      .filter(peer => peer[1].stateChange! + 1 * hour < Date.now())
      .forEach(([addr]) => this.ssb.conn.disconnect(addr));
  }

  private updateNow() {
    if (this.hasSsbDb && !this.ssb.ready()) return;
    if (this.isCurrentlyDownloading()) return;
    if (this.isLoadingHops) return;

    this.updateStagingNow();
    this.updateHubNow();
  }

  private updateSoon(period: number = 1000) {
    if (this.closed) return;
    if (this.hasScheduledAnUpdate) return;

    // Add some time randomization to avoid deadlocks with remote peers
    const fuzzyPeriod = period * 0.5 + period * Math.random();
    this.hasScheduledAnUpdate = true;
    const timer = setTimeout(() => {
      this.updateNow();
      this.hasScheduledAnUpdate = false;
    }, fuzzyPeriod);
    if (timer.unref) timer.unref();
  }

  private populateWithSeeds() {
    // Populate gossip table with configured seeds (mainly used in testing)
    const seeds = this.config.seeds;
    (Array.isArray(seeds) ? seeds : [seeds]).filter(Boolean).forEach(addr => {
      const key = Ref.getKeyFromAddress(addr);
      this.ssb.conn.remember(addr, {key, source: 'seed'});
    });
  }

  private setupPubDiscovery() {
    if (!this.hasSsbDb) {
      debug('Warning: ssb-db is missing, scheduling will miss some info');
      return;
    }

    if (this.config.gossip && this.config.gossip.pub === false) return;
    if (this.config.gossip && this.config.gossip.autoPopulate === false) return;

    setTimeout(() => {
      type PubContent = {address?: string};
      const MAX_STAGED_PUBS = 3;
      const pausable = Pausable();

      pull(
        this.ssb.messagesByType({type: 'pub', live: true, keys: false}),
        pull.filter((msg: any) => !msg.sync),
        // Don't drain that fast, so to give other DB draining tasks priority
        pull.asyncMap((x: any, cb: any) => setTimeout(() => cb(null, x), 250)),
        pull.filter(
          (msg: Msg<PubContent>['value']) =>
            msg.content &&
            msg.content.address &&
            Ref.isAddress(msg.content.address),
        ),
        pausable,
        pull.drain((msg: Msg<PubContent>['value']) => {
          try {
            const address = Ref.toMultiServerAddress(msg.content.address!);
            const key = Ref.getKeyFromAddress(address);
            if (this.weBlockThem([address, {key}])) {
              this.ssb.conn.forget(address);
            } else if (!this.ssb.conn.db().has(address)) {
              this.ssb.conn.stage(address, {key, type: 'pub'});
              this.ssb.conn.remember(address, {
                key,
                type: 'pub',
                autoconnect: false,
              });
            }
          } catch (err) {
            debug('cannot process discovered pub because: %s', err);
          }
        }),
      );

      // Pause or resume the draining depending on the number of staged pubs
      pull(
        this.ssb.conn.staging().liveEntries(),
        pull.drain((staged: Array<any>) => {
          const stagedPubs = staged.filter(([, data]) => data.type === 'pub');
          if (stagedPubs.length >= MAX_STAGED_PUBS) {
            pausable.pause();
          } else {
            pausable.resume();
          }
        }),
      );
    }, 1000);
  }

  private setupBluetoothDiscovery() {
    if (!this.ssb.bluetooth || !this.ssb.bluetooth.nearbyScuttlebuttDevices) {
      debug(
        'Warning: ssb-bluetooth is missing, scheduling will miss some info',
      );
      return;
    }

    pull(
      this.ssb.bluetooth.nearbyScuttlebuttDevices(1000),
      pull.drain(({discovered}: {discovered: Array<BTPeer>}) => {
        for (const btPeer of discovered) {
          const address =
            `bt:${btPeer.remoteAddress.split(':').join('')}` +
            '~' +
            `shs:${btPeer.id.replace(/^\@/, '').replace(/\.ed25519$/, '')}`;
          const data: Partial<StagedData> = {
            type: 'bt',
            note: btPeer.displayName,
            key: btPeer.id,
          };
          if (this.weFollowThem([address, data])) {
            this.ssb.conn.connect(address, data);
          } else {
            this.ssb.conn.stage(address, data);
          }
        }
      }),
    );
  }

  private setupLanDiscovery() {
    if (!this.ssb.lan || !this.ssb.lan.start || !this.ssb.lan.discoveredPeers) {
      debug('Warning: ssb-lan is missing, scheduling will miss some info');
      return;
    }

    pull(
      this.ssb.lan.discoveredPeers(),
      pull.drain(({address, verified}: LANDiscovery) => {
        const peer = Ref.parseAddress(address);
        if (!peer || !peer.key) return;
        const data: Partial<StagedData> = {
          type: 'lan',
          key: peer.key,
          verified,
        };
        if (this.weFollowThem([address, data])) {
          this.ssb.conn.connect(address, data);
        } else {
          this.ssb.conn.stage(address, data);
        }
      }),
    );

    this.ssb.lan.start();
  }

  @muxrpc('sync')
  public start = () => {
    if (!this.closed) return;
    this.closed = false;

    // Upon init, purge some undesired DB entries
    for (let [address, {source, type}] of this.ssb.conn.dbPeers()) {
      if (
        source === 'local' ||
        source === 'bt' ||
        type === 'lan' ||
        type === 'bt'
      ) {
        this.ssb.conn.forget(address);
      }
    }

    // Upon init, load some follow-and-blocks data
    this.loadHops();

    // Upon init, populate with seeds
    this.populateWithSeeds();

    // Upon init, setup discovery via various modes
    this.setupPubDiscovery();
    this.setupLanDiscovery();
    this.setupBluetoothDiscovery();

    // Upon regular time intervals, attempt to make connections
    const int = setInterval(() => this.updateSoon(), 2e3);
    if (int.unref) int.unref();

    // Upon wakeup, trigger hard reconnect
    onWakeup(() => this.ssb.conn.hub().reset());

    // Upon network changes, trigger hard reconnect
    onNetwork(() => this.ssb.conn.hub().reset());

    // Upon some disconnection, attempt to make connections
    pull(
      this.ssb.conn.hub().listen(),
      pull.filter((ev: HubEvent) => ev.type === 'disconnected'),
      pull.drain(() => this.updateSoon(200)),
    );

    // Upon init, attempt to make some connections
    this.updateSoon();
  };

  @muxrpc('sync')
  public stop = () => {
    if (this.ssb.lan && this.ssb.lan.stop) this.ssb.lan.stop();
    this.ssb.conn.hub().reset();
    this.closed = true;
  };
}
