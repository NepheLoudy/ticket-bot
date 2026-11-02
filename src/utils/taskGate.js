/**
 * 定时任务互斥运行闸门（running 标志 + 看门狗强制复位 + 令牌防误复位）
 *
 * 背景：2026-11-01 网络故障窗口内一轮播报对账的某个出站请求永久悬挂（具体挂点
 * 未能实锤——当时唯一无 signal 的出站 fetch 是 token 请求，DNS 挂死型故障不受
 * undici connectTimeout 保护；已随后续批次全部补上 signal），互斥标志恒 true，
 * 兜底补播停摆 48.8h 才被发现。`.finally` 复位只覆盖「promise 会 settle」的
 * 场景，防不住悬挂——看门狗按「单轮持续运行超过阈值」强制放行新一轮，代价是
 * 可能遗留一个僵尸 promise（有界，重启即清），换取兜底机制永不停摆。
 *
 * 令牌机制：看门狗复位后旧轮 promise 迟到 settle 时，其 finally 携带的旧令牌
 * 与当前令牌不符，不会误清新一轮的运行标志（否则会造成双轮并发）。
 *
 * @param {string} name 任务名（告警日志用）
 * @param {number} watchdogMs 单轮最大运行时长，超过即强制复位放行新一轮
 * @returns {{tryEnter: () => number|null, leave: (token: number) => void}}
 *   tryEnter：空闲（或看门狗强制复位）时返回本轮令牌；上一轮仍在运行返回 null
 *   leave：持令牌者正常/异常结束时调用，复位运行标志（令牌不符则忽略）
 */
function createTaskGate(name, watchdogMs) {
  let running = false;
  let startedAt = 0;
  let token = 0;

  return {
    tryEnter() {
      if (running) {
        if (Date.now() - startedAt <= watchdogMs) return null;
        console.error(
          `[定时任务] ⚠️ ${name}已持续运行超过 ${Math.round(watchdogMs / 60000)} 分钟未结束（疑似请求悬挂卡死），看门狗强制复位并放行新一轮；旧轮僵尸 promise 由下次重启清理`
        );
      }
      running = true;
      startedAt = Date.now();
      return ++token;
    },
    leave(myToken) {
      if (myToken !== token) return;
      running = false;
    },
  };
}

module.exports = { createTaskGate };
