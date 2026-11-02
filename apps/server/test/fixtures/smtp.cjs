const net = require('node:net');

async function smtpFixture() {
  const messages = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 fixture ESMTP\r\n');
    let buffer = '', inData = false, body = [];
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            messages.push(body.join('\r\n')); body = []; inData = false;
            socket.write('250 accepted\r\n');
          } else body.push(line);
          continue;
        }
        if (line.startsWith('EHLO')) socket.write('250 fixture\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
module.exports = { smtpFixture };
