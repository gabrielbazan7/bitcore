import * as async from 'async';
import * as _ from 'lodash';
import moment from 'moment';
import * as mongodb from 'mongodb';

const config = require('../config');
const storage = require('./storage');
let log = require('npmlog');
log.debug = log.verbose;
log.disableColor();

const INITIAL_DATE = '2015-01-01';

export interface IStats {
  network: string;
  coin: string;
  from: Date;
  to: Date;
  fromTs: number;
  toTs: number;
}
export class Stats {
  network: string;
  coin: string;
  from: moment.MomentFormatSpecification;
  to: moment.MomentFormatSpecification;
  db: mongodb.Db;

  constructor(opts) {
    opts = opts || {};

    this.network = opts.network || 'livenet';
    this.coin = opts.coin || 'btc';
    this.from = moment(opts.from || INITIAL_DATE).format('YYYY-MM-DD');
    this.to = moment(opts.to).format('YYYY-MM-DD');
  }

  run(cb) {
    let uri = config.storageOpts.mongoDb.uri;

    if (uri.indexOf('?') > 0) {
      uri = uri + '&';
    } else {
      uri = uri + '?';
    }
    uri = uri + 'readPreference=secondaryPreferred';
    mongodb.MongoClient.connect(
      uri,
      (err, db) => {
        if (err) {
          log.error('Unable to connect to the mongoDB', err);
          return cb(err, null);
        }
        log.info('Connection established to ' + uri);
        this.db = db;
        this._getStats((err, stats) => {
          if (err) return cb(err);
          return cb(null, stats);
        });
      }
    );
  }

  _getStats(cb) {
    let result = {};
    async.series(
      [
        (next) => {
          this._getNewWallets(next);
        },
        (next) => {
          this._getFiatRates(next);
        },
        (next) => {
          this._getTxProposals(next);
        },
      ],
      (err, results) => {
        if (err) return cb(err);
        result = { newWallets: results[0], fiatRates: results[1], txProposals: results[2] };
        return cb(null, result);
      }
    );
  }

  _getNewWallets(cb) {
    const getLastDate = cb => {
      this.db
        .collection('stats_wallets')
        .find({ '_id.coin': this.coin })
        .sort({
          '_id.day': -1
        })
        .limit(1)
        .toArray((err, lastRecord) => {
          if (_.isEmpty(lastRecord)) return cb(null, moment(INITIAL_DATE));
          return cb(null, moment(lastRecord[0]._id.day));
        });
    };
    const updateStats = (from, yesterday, cb) => {
      this.db
        .collection(storage.Storage.collections.WALLETS)
        .aggregate(
          [
            {
              $match: {
                createdOn: {
                  $gt: from.valueOf() / 1000,
                  $lt: yesterday.valueOf() / 1000
                }
              }
            },
            {
              $project: {
                date: { $add: [new Date(0), { $multiply: ['$createdOn', 1000] }] },
                network: '$network',
                coin: '$coin',
              }
            },
            {
              $group: {
                _id: {
                  day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
                  network: '$network',
                  coin: '$coin'
                },
                count: { $sum: 1 },
              }
            }
          ]
        ).toArray(async (err, res) => {
          if (err) return cb(err);
          try {
            await this.db.collection('stats_wallets').insertMany(res, { ordered: false });
          } catch (err) { }
          return cb();
        });
    };
    const queryStats = (cb) => {
      this.db
        .collection('stats_wallets')
        .find({
          '_id.network': this.network,
          '_id.coin': this.coin,
          '_id.day': {
            $gte: this.from,
            $lte: this.to
          }
        })
        .sort({
          '_id.day': 1
        })
        .toArray((err, results) => {
          if (err) return cb(err);
          const stats = {
            byDay: _.map(results, (record) => {
              const day = moment(record._id.day).format('YYYYMMDD');
              return {
                day,
                coin: record._id.coin,
                value: record._id.value,
                count: record.count ? record.count : record.value.count
              };
            })
          };
          return cb(null, stats);
        });
    };

    async.series(
      [
        (next) => {
          getLastDate((err, lastDate) => {
            if (err) return next(err);

            lastDate = lastDate.startOf('day');
            const yesterday = moment()
              .subtract(1, 'day')
              .startOf('day');
            if (lastDate.isBefore(yesterday)) {
              // Needs update
              return updateStats(lastDate, yesterday, next);
            }
            next();
          });
        },
        (next) => {
          queryStats(next);
        }
      ],
      (err, res) => {
        if (err) {
          log.error(err);
        }
        return cb(err, res[1]);
      }
    );
  }

  _getFiatRates(cb) {
    const getLastDate = cb => {
      this.db
        .collection('stats_fiat_rates')
        .find({ '_id.coin': this.coin })
        .sort({
          '_id.day': -1
        })
        .limit(1)
        .toArray((err, lastRecord) => {
          if (_.isEmpty(lastRecord)) return cb(null, moment(INITIAL_DATE));
          return cb(null, moment(lastRecord[0]._id.day));
        });
    };
    const updateStats = (from, yesterday, cb) => {
      this.db
        .collection(storage.Storage.collections.FIAT_RATES2)
        .aggregate(
          [
            {
              $match: {
                ts: {
                  $gt: from.valueOf() / 1000,
                  $lt: yesterday.valueOf() / 1000
                },
                code: 'USD'
              }
            },
            {
              $project: {
                date: { $add: [new Date(0), '$ts'] },
                coin: '$coin',
                value: '$value'
              }
            },
            {
              $group: {
                _id: {
                  day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
                  coin: '$coin',
                  value: '$value'
                }
              }
            }
          ]
        ).toArray(async (err, res) => {
          if (err) return cb(err);
          try {
            await this.db.collection('stats_fiat_rates').insertMany(res, { ordered: false });
          } catch (err) { }
          return cb();
        });
    };
    const queryStats = (cb) => {
      this.db
        .collection('stats_fiat_rates')
        .find({
          '_id.coin': this.coin,
          '_id.day': {
            $gte: this.from,
            $lte: this.to
          }
        })
        .sort({
          '_id.day': 1
        })
        .toArray((err, results) => {
          if (err) return cb(err);
          const stats = {
            byDay: [],
          };
          _.each(results, (record) => {
            const day = moment(record._id.day).format('YYYYMMDD');
            stats.byDay.push({
              day,
              coin: record._id.coin,
              value: record._id.value
            });
          });
          return cb(null, stats);
        });
    };

    async.series(
      [
        (next) => {
          getLastDate((err, lastDate) => {
            if (err) return next(err);

            lastDate = lastDate.startOf('day');
            const yesterday = moment()
              .subtract(1, 'day')
              .startOf('day');
            if (lastDate.isBefore(yesterday)) {
              // Needs update
              return updateStats(lastDate, yesterday, next);
            }
            next();
          });
        },
        (next) => {
          queryStats(next);
        }
      ],
      (err, res) => {
        if (err) {
          log.error(err);
        }
        return cb(err, res[1]);
      }
    );
  }

  _getTxProposals(cb) {
    const getLastDate = (cb) => {
      this.db
        .collection('stats_txps')
        .find({ '_id.coin': this.coin })
        .sort({
          '_id.day': -1
        })
        .limit(1)
        .toArray((err, lastRecord) => {
          if (_.isEmpty(lastRecord)) return cb(null, moment(INITIAL_DATE));
          return cb(null, moment(lastRecord[0]._id.day));
        });
    };
    const updateStats = (from, yesterday, cb) => {
      this.db
        .collection(storage.Storage.collections.TXS)
        .aggregate(
          [
            {
              $match: {
                broadcastedOn: {
                  $gt: from.valueOf() / 1000,
                  $lt: yesterday.valueOf() / 1000
                }
              }
            },
            {
              $project: {
                date: { $add: [new Date(0), { $multiply: ['$broadcastedOn', 1000] }] },
                network: '$network',
                coin: '$coin',
                amount: '$amount'
              }
            },
            {
              $group: {
                _id: {
                  day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
                  network: '$network',
                  coin: '$coin'
                },
                amount: { $sum: '$amount' },
                count: { $sum: 1 },
              }
            }
          ]
        ).toArray(async (err, res) => {
          if (err) return cb(err);
          try {
            await this.db.collection('stats_txps').insertMany(res, { ordered: false });
          } catch (err) {
          }
          return cb();
        });
    };

    const queryStats = (cb) => {
      this.db
        .collection('stats_txps')
        .find({
          '_id.network': this.network,
          '_id.coin': this.coin,
          '_id.day': {
            $gte: this.from,
            $lte: this.to
          }
        })
        .sort({
          '_id.day': 1
        })
        .toArray((err, results) => {
          if (err) return cb(err);
          const stats = {
            nbByDay: [],
            amountByDay: []
          };
          _.each(results, (record) => {
            const day = moment(record._id.day).format('YYYYMMDD');
            stats.nbByDay.push({
              day,
              coin: record._id.coin,
              count: record.count ? record.count : record.value.count
            });
            stats.amountByDay.push({
              day,
              amount: record.amount ? record.amount : record.value.amount
            });
          });
          return cb(null, stats);
        });
    };
    async.series(
      [
        (next) => {
          getLastDate((err, lastDate) => {
            if (err) return next(err);
            lastDate = lastDate.startOf('day');
            const yesterday = moment()
              .subtract(1, 'day')
              .startOf('day');
            if (lastDate.isBefore(yesterday)) {
              // Needs update
              return updateStats(lastDate, yesterday, next);
            }
            next();
          });
        },
        (next) => {
          queryStats(next);
        }
      ],
      (err, res) => {
        if (err) {
          log.error(err);
        }
        return cb(err, res[1]);
      }
    );
  }
}