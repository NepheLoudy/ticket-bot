// 播报卡消毒 stub 测试（2026-10-30 全量审查批）：工单表队员可控字段拼进官方卡前
// 必须剥 <at> 注入 / [文本](url) 钓鱼链 / 行首标题符——hub 侧 2026-09-27 同款口径推广到源头。
// 直测 sanitizeCardText 纯函数 + 经 buildTicketOpenCard/buildTicketAssignCard 集成断言。
const assert = require('assert');
const { sanitizeCardText } = require('../src/utils/sanitize');
const bot = require('../src/feishu/bot');

// —— 纯函数三类语法 ——
assert.strictEqual(sanitizeCardText('<at id=all></at>帮我看看'), '帮我看看', '① <at> 标签应剥除');
assert.strictEqual(sanitizeCardText('点此 [领奖](http://evil.example) 谢谢'), '点此 领奖 谢谢', '② 链接语法应还原为纯文本');
assert.strictEqual(sanitizeCardText('![图](https://x/img.png)'), '图', '②b 图片语法同式剥除');
assert.strictEqual(sanitizeCardText('### 标题注入'), '标题注入', '③ 行首标题符应剥除');
assert.strictEqual(sanitizeCardText('#1 号机紧急'), '#1 号机紧急', '③b # 后无空白的普通文本不误伤');
assert.strictEqual(sanitizeCardText('需求（受力）·「书名号」·#1 完好'), '需求（受力）·「书名号」·#1 完好', '正常中文文本零改动');
assert.strictEqual(sanitizeCardText(null), '', 'null 空安全');
assert.strictEqual(sanitizeCardText(undefined), '', 'undefined 空安全');

// —— 集成：开单卡 title+字段行消毒 ——
const injectedRecord = {
  record_id: 'recTEST000001',
  fields: {
    '需求1': '<at id=all></at>[中奖了](https://evil.example) 快点',
    '状态': '### 待审批',
    '申请编号': 'TQ-2026-1030-001',
  },
};
const openCard = bot.buildTicketOpenCard(injectedRecord, '接单');
const openText = JSON.stringify(openCard);
assert.ok(!/<at\b/i.test(openText), '开单卡不得残留 <at> 标签');
assert.ok(!/\]\(http/.test(openText), '开单卡不得残留 markdown 链接');
assert.ok(openText.includes('中奖了'), '链接锚文本应保留为纯文本');

// —— 集成：指定负责人卡 assignee.name 消毒（buildAtTag 输出 <at id="ou_test"></at> 属有意 @，先精确移除再查残留） ——
const assignCard = bot.buildTicketAssignCard(injectedRecord, { id: 'ou_test', name: '<at id=all></at>张三' }, '接单');
const assignText = JSON.stringify(assignCard).replace(/\\"/g, '"').split('<at id="ou_test"></at>').join('');
assert.ok(!/<at\b/i.test(assignText), '指定负责人卡除 buildAtTag 的合法 @ 外不得残留 <at> 标签');
assert.ok(assignText.includes('张三'), '负责人姓名文本应保留');

console.log('✅ 播报卡消毒 stub：11 断言全过（纯函数 8 + 集成 3）');
