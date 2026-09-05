/**
 * 部署后验证：pm2 状态 + 两服务 health + ticket-bot 分桶 API dry-run + 启动日志关键行
 * 用法：node scripts/verify-nas.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('ssh2');

const cfg = {
  host: process.env.NAS_HOST,
  port: Number(process.env.NAS_PORT || 22),
  username: process.env.NAS_USER,
  password: process.env.NAS_PASSWORD,
  readyTimeout: 20000,
  keepaliveInterval: 5000,
};

function run(client, cmd) {
  return new Promise((resolve) => {
    client.exec(cmd, (err, stream) => {
      if (err) return resolve(`(exec 失败: ${err.message})`);
      let out = '';
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { out += d.toString(); });
      stream.on('close', () => resolve(out.trim()));
    });
  });
}

(async () => {
  const client = new Client();
  await new Promise((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect(cfg);
  });

  console.log('—— pm2 进程状态 ——');
  console.log(await run(client, "pm2 ls | grep -E 'ticket-bot|knowledge-tracker'"));

  console.log('\n—— health 检查 ——');
  console.log('ticket-bot 3003:', await run(client, 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/api/health'));
  console.log('hub 3000      :', await run(client, 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health'));

  console.log('\n—— 分桶 API dry-run（前 600 字符）——');
  console.log((await run(client, 'curl -s http://localhost:3003/api/tickets/unclosed-by-group')).slice(0, 600));

  console.log('\n—— ticket-bot 启动关键行（近 200 行内匹配）——');
  console.log(await run(client, 'grep -E "长连接模式|播报路由|对账" ~/.pm2/logs/ticket-bot-out.log | tail -8'));

  console.log('\n—— 漏播单补播检查（202609050003 / recvulRfoRHhsI）——');
  console.log(await run(client, 'grep -E "recvulRfoRHhsI|补播|对账" ~/.pm2/logs/ticket-bot-out.log | tail -12'));

  console.log('\n—— hub 启动关键行 ——');
  console.log(await run(client, 'grep -E "长连接模式|下次执行时间|定时任务" ~/.pm2/logs/knowledge-tracker-out.log | tail -5'));

  client.end();
})().catch((e) => { console.error('验证失败:', e.message); process.exit(1); });
