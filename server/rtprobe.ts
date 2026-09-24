import { WebSocketServer, WebSocket } from 'ws';
const wss = new WebSocketServer({ port: 0 });
wss.on('listening', () => {
  const port = (wss.address() as any).port;
  console.log('stub upstream on', port);
  const c = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?model=x`, { headers: { Authorization: 'Bearer k' } });
  c.on('open', () => { console.log('OPEN ok'); c.send('{"a":1}'); });
  c.on('message', (d) => console.log('MSG', d.toString()));
  c.on('error', (e) => console.log('ERR', e.message));
  c.on('close', (code, r) => { console.log('CLOSE', code, r.toString()); wss.close(); });
});
wss.on('connection', (s) => { console.log('upstream got connection'); s.on('message', (d) => { console.log('upstream recv', d.toString()); s.send('echo'); }); });
