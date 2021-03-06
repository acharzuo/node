'use strict';
const common = require('../common');
const assert = require('assert');

if (!common.hasCrypto) {
  common.skip('missing crypto');
  return;
}
const tls = require('tls');

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

const keys = crypto.randomBytes(48);
const serverLog = [];
const ticketLog = [];

let serverCount = 0;
function createServer() {
  const id = serverCount++;

  let counter = 0;
  let previousKey = null;

  const server = tls.createServer({
    key: fs.readFileSync(common.fixturesDir + '/keys/agent1-key.pem'),
    cert: fs.readFileSync(common.fixturesDir + '/keys/agent1-cert.pem'),
    ticketKeys: keys
  }, function(c) {
    serverLog.push(id);
    c.end();

    counter++;

    // Rotate ticket keys
    if (counter === 1) {
      previousKey = server.getTicketKeys();
      server.setTicketKeys(crypto.randomBytes(48));
    } else if (counter === 2) {
      server.setTicketKeys(previousKey);
    } else if (counter === 3) {
      // Use keys from counter=2
    } else {
      throw new Error('UNREACHABLE');
    }
  });

  return server;
}

const naturalServers = [ createServer(), createServer(), createServer() ];

// 3x servers
const servers = naturalServers.concat(naturalServers).concat(naturalServers);

// Create one TCP server and balance sockets to multiple TLS server instances
const shared = net.createServer(function(c) {
  servers.shift().emit('connection', c);
}).listen(0, function() {
  start(function() {
    shared.close();
  });
});

function start(callback) {
  let sess = null;
  let left = servers.length;

  function connect() {
    const s = tls.connect(shared.address().port, {
      session: sess,
      rejectUnauthorized: false
    }, function() {
      sess = sess || s.getSession();
      ticketLog.push(s.getTLSTicket().toString('hex'));
    });
    s.on('close', function() {
      if (--left === 0)
        callback();
      else
        connect();
    });
  }

  connect();
}

process.on('exit', function() {
  assert.strictEqual(ticketLog.length, serverLog.length);
  for (let i = 0; i < naturalServers.length - 1; i++) {
    assert.notStrictEqual(serverLog[i], serverLog[i + 1]);
    assert.strictEqual(ticketLog[i], ticketLog[i + 1]);

    // 2nd connection should have different ticket
    assert.notStrictEqual(ticketLog[i], ticketLog[i + naturalServers.length]);

    // 3rd connection should have the same ticket
    assert.strictEqual(ticketLog[i], ticketLog[i + naturalServers.length * 2]);
  }
});
