// a simple websocket server
//
var WebSocketServer = require('ws').Server
  , _ = require('lodash')
  , http = require('http')
  , redis = require('redis')
  , lruCache = require('lru-cache')

  , web = require('./lib/web')
  , CommandHandler = require('./lib/command-handler').CommandHandler
  , port = (process.env.PORT || 8080)
  , TCPToWS = require('./lib/tcp-ws').TCPToWS;


// setup redis client
var redisClient = redis.createClient();
redisClient.on('error', function(err) {
	console.log('Connection to redis server errored: ' + err);
});

redisClient.on('ready', function() {
	console.log('Connection to redis server established.');
});


// setup rh cache for routing
var lru = lruCache({ 
	max: 10,
	maxAge: 5000
});

var readFromCache = function(key, cb) {
	var r = lru.get(key);
	if (r !== undefined)
		return cb(null, r);

	redisClient.lrange('rh', 0, -1, function(err, v) {
		if (err) return cb(err);
		if (_.isEmpty(v))
			return cb(new Error('There are no request handlers registered'));
		lru.set(key, v);
		cb(null, v);
	});
}

var pickRequestHandler = function(cb) {
	readFromCache('rh', function(err, v) {
		if (err) return cb(err);

		var rh = v[Math.floor(Math.random() * v.length)];
		console.log('Picker request handler: ' + rh);

		return cb(null, rh);
	});
}

var registerForHipache = function(cb) {
	// check if we have a valid request handler
	//
	var host = (process.env.HOST || 'localhost');
	var key = 'frontend:' + host;
	var self = 'http://127.0.0.1:' + port;

	var unregister = function() {
		redisClient.lrem(key, 0, self, function(err) {
			if (err) return console.log('Error trying to unregister from hipache list: ' + err);
			console.log('Unregistered from hipache list');
			
			process.exit();
		});
	}

	process.on('exit', unregister);
	process.on('SIGHUP', unregister);
	process.on('SIGINT', unregister);

	var registerSelf = function() {
		console.log('Registering this websocket server as: ' + self);
		redisClient.rpush(key, self, cb);
	}

	redisClient.lrange(key, 0, 1, function(err, res) {
		if (err) return cb(err);

		if (_.isEmpty(res)) {
			console.log('Site index does not exist, adding...');
			// no id as been added, add one now
			redisClient.rpush(key, 'point-serve', function(err) {
				if (err) return cb(err);

				console.log('Site index added.');
				registerSelf();
			});
		}
		else
			registerSelf();
	});
}

var affinityCache = lruCache({
	max: 1000,
	maxAge: 1000
});

var setAffinity = function(session, target, cb) {
	redisClient.hset('affinity', session, target, function(err, v) {
		if (err) return cb(err);
		affinityCache.set(session, target);
		cb(null, v);
	})
}

var getAffinity = function(session, cb) {
	var v = affinityCache.get(session);
	if (v !== undefined)
		return cb(null, v);

	redisClient.hget('affinity', session, function(err, val) {
		if (err) return cb(err);

		affinityCache.set(session, val);
		cb(null, val);
	});
}

var deleteAffinity = function(session, cb) {
	redisClient.hdel('affinity', session, function(err, val) {
		if (err) return cb(err);
		affinityCache.del(session);
		cb();
	});
}

process.nextTick(function() {
	registerForHipache(function(err) {
		if (err) return console.log(err);

		var wss = new WebSocketServer({port: port});

		console.log('Websocket server running on port: ' + port);

		var validateSessionAffinity = function(session, cb) {
			if (!session)
				return cb(new Error('Session parameter is invalid or missing'));

			getAffinity(session, function(err, val) {
				console.log('affinity(' + session + ') = ' + val)
				cb(err, session, val);
			});
		}

		wss.on('connection', function(ws) {
			var handler = new CommandHandler(ws);

			handler.on('create', function(msg, cb) {
				pickRequestHandler(function(err, rh) {
					if (err) return cb(err);

					web.post(rh, '/create', function(err, res) {
						if (err) return cb(err);

						setAffinity(res.sessionId, rh, function(err) {
							if (err) {
								// atleast try to clean session
								web._delete(rh, '/' + session, function() { });
								return cb(err);
							}

							// everything went fine, we're good
							cb(null, { session: res.sessionId });
						});
					});
				});
			});

			handler.on('pointsCount', function(msg, cb) {
				validateSessionAffinity(msg.session, function(err, session, rh) {
					if (err) return cb(err);
					web.get(rh, '/pointsCount/' + session, cb);
				});
			});

			handler.on('destroy', function(msg, cb) {
				validateSessionAffinity(msg.session, function(err, session, rh) {
					web._delete(rh, '/' + session, function(err, res) {
						if (err) return cb(err);

						deleteAffinity(session, function(err) {
							if (err) console.log('destroying session, but affinity was not correctly cleared', err);
							cb();
						});
					});
				});
			});

			handler.on('read', function(msg, cb) {
				validateSessionAffinity(msg.session, function(err, session, rh) {
					var streamer = new TCPToWS(ws);
					streamer.on('local-address', function(add) {
						console.log('local-bound address for read: ', add);

						web.post(rh, '/read/' + session, _.extend(add, {
							start: msg.start,
							count: msg.count
						}), function(err, r) {
							if (err) {
								streamer.close();
								return cb(err);
							}
							console.log('TCP-WS: points: ', r.pointsRead, 'bytes:', r.bytesCount);

							cb(null, r);
							process.nextTick(function() {
								streamer.startPushing();
							});
						});
					});

					streamer.on('end', function() {
						console.log('Done transmitting point data');
					});

					streamer.start();
				});
			});
		});
	});
});