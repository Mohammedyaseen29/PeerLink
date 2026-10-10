const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const mib = 1024 * 1024;
const config = {
  warmMiB: Number(process.env.PEERLINK_PROFILE_WARM_MIB || 8),
  measuredMiB: Number(process.env.PEERLINK_PROFILE_MEASURE_MIB || 16),
  highWater: Number(process.env.PEERLINK_PROFILE_HIGH_WATER_BYTES || 262144),
  lowWater: Number(process.env.PEERLINK_PROFILE_LOW_WATER_BYTES || 131072),
  frameBytes: Number(process.env.PEERLINK_PROFILE_CHUNK_BYTES || 65536),
  deadlineMs: Number(process.env.PEERLINK_PROFILE_DEADLINE_MS || 120000),
};
const executable = process.env.PEERLINK_CHROME ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

function assertConfig() {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer; got ${value}`);
    }
  }
  if (config.frameBytes > config.highWater) {
    throw new Error('frameBytes must not exceed highWater');
  }
  if (config.lowWater >= config.highWater) {
    throw new Error('lowWater must be less than highWater');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gatherIce(page) {
  await page.evaluate(async () => {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('ICE gathering timeout')), 20000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  });
}

async function main() {
  assertConfig();
  let senderBrowser;
  let receiverBrowser;
  try {
    senderBrowser = await chromium.launch({ headless: true, executablePath: executable });
    receiverBrowser = await chromium.launch({ headless: true, executablePath: executable });
    const sender = await senderBrowser.newPage();
    const receiver = await receiverBrowser.newPage();
    const userAgent = await sender.evaluate(() => navigator.userAgent);

    await sender.evaluate(() => {
      window.pc = new RTCPeerConnection();
      window.dc = pc.createDataChannel('profile', { ordered: true });
      window.currentId = '';
      window.readyId = '';
      window.ack = null;
      dc.onmessage = event => {
        if (typeof event.data !== 'string') return;
        const [type, id, value] = event.data.split('|');
        if (id !== window.currentId) return;
        if (type === 'READY') window.readyId = id;
        if (type === 'ACK') window.ack = { id, receivedBytes: Number(value) };
      };
    });
    await sender.evaluate(async () => pc.setLocalDescription(await pc.createOffer()));
    await gatherIce(sender);
    const offer = await sender.evaluate(() => pc.localDescription);

    await receiver.evaluate(() => {
      window.pc = new RTCPeerConnection();
      window.runId = '';
      window.expectedBytes = 0;
      window.receivedBytes = 0;
      window.rates = [];
      pc.ondatachannel = event => {
        window.dc = event.channel;
        dc.binaryType = 'arraybuffer';
        dc.onmessage = message => {
          if (message.data instanceof ArrayBuffer) {
            window.receivedBytes += message.data.byteLength;
            return;
          }
          const [type, id, value] = String(message.data).split('|');
          if (type === 'START') {
            window.runId = id;
            window.expectedBytes = Number(value);
            window.receivedBytes = 0;
            window.rates = [];
            window.rateAt = performance.now();
            window.rateBytes = 0;
            clearInterval(window.rateTimer);
            window.rateTimer = setInterval(() => {
              const now = performance.now();
              const seconds = (now - window.rateAt) / 1000;
              window.rates.push({
                seconds: +seconds.toFixed(2),
                receiveMiBps: +(((window.receivedBytes - window.rateBytes) / 1048576 / seconds).toFixed(2)),
              });
              window.rateAt = now;
              window.rateBytes = window.receivedBytes;
            }, 1000);
            dc.send(`READY|${id}`);
          } else if (type === 'END' && id === window.runId) {
            clearInterval(window.rateTimer);
            dc.send(`ACK|${id}|${window.receivedBytes}`);
          }
        };
      };
    });
    await receiver.evaluate(async remoteOffer => {
      await pc.setRemoteDescription(remoteOffer);
      await pc.setLocalDescription(await pc.createAnswer());
    }, offer);
    await gatherIce(receiver);
    const answer = await receiver.evaluate(() => pc.localDescription);
    await sender.evaluate(remoteAnswer => pc.setRemoteDescription(remoteAnswer), answer);
    await Promise.all([
      sender.waitForFunction(() => dc.readyState === 'open', null, { timeout: 20000 }),
      receiver.waitForFunction(() => window.dc?.readyState === 'open', null, { timeout: 20000 }),
    ]);

    const selectedPair = () => sender.evaluate(async () => {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach(stat => {
        if (stat.type === 'transport' && stat.selectedCandidatePairId) {
          pair = stats.get(stat.selectedCandidatePairId);
        }
      });
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      return {
        rtt: pair.currentRoundTripTime ?? null,
        bytesSent: pair.bytesSent ?? null,
        bytesReceived: pair.bytesReceived ?? null,
        packetsSent: pair.packetsSent ?? null,
        packetsReceived: pair.packetsReceived ?? null,
        packetsDiscardedOnSend: pair.packetsDiscardedOnSend ?? null,
        bytesDiscardedOnSend: pair.bytesDiscardedOnSend ?? null,
        availableOutgoingBitrate: pair.availableOutgoingBitrate ?? null,
        localType: local?.candidateType ?? null,
        remoteType: remote?.candidateType ?? null,
        protocol: local?.protocol ?? null,
      };
    });

    async function waitForReady(id, deadline) {
      while (Date.now() < deadline) {
        const state = await sender.evaluate(() => ({
          readyId: window.readyId,
          currentId: window.currentId,
          state: dc.readyState,
        }));
        if (state.state !== 'open') throw Error(`DataChannel closed: ${state.state}`);
        if (state.readyId === id && state.currentId === id) return;
        await sleep(50);
      }
      throw Error(`READY deadline exceeded for ${id}`);
    }

    async function run(label, totalBytes) {
      const id = crypto.randomUUID();
      const deadline = Date.now() + config.deadlineMs;
      await sender.evaluate(({ id, totalBytes, lowWater }) => {
        window.currentId = id;
        window.readyId = '';
        window.ack = null;
        dc.bufferedAmountLowThreshold = lowWater;
        dc.send(`START|${id}|${totalBytes}`);
      }, { id, totalBytes, lowWater: config.lowWater });
      await waitForReady(id, deadline);

      const start = await sender.evaluate(() => performance.now());
      const result = await sender.evaluate(async ({ id, totalBytes, highWater, frameBytes, deadline }) => {
        const payload = new ArrayBuffer(frameBytes);
        let sentBytes = 0;
        let peakBufferedBytes = dc.bufferedAmount;
        let previousBytes = 0;
        let rateStart = performance.now();
        const senderRates = [];
        const ticker = setInterval(() => {
          const now = performance.now();
          const seconds = (now - rateStart) / 1000;
          senderRates.push({
            seconds: +seconds.toFixed(2),
            enqueueMiBps: +(((sentBytes - previousBytes) / 1048576 / seconds).toFixed(2)),
          });
          rateStart = now;
          previousBytes = sentBytes;
        }, 1000);

        async function waitBelowHigh(nextBytes) {
          while (dc.bufferedAmount + nextBytes > highWater) {
            if (Date.now() >= deadline) throw Error('overall send deadline exceeded');
            await new Promise((resolve, reject) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                dc.removeEventListener('bufferedamountlow', finish);
                resolve();
              };
              const remaining = Math.max(1, deadline - Date.now());
              const timer = setTimeout(finish, Math.min(100, remaining));
              dc.addEventListener('bufferedamountlow', finish);
              if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) finish();
              if (dc.readyState !== 'open') {
                settled = true;
                clearTimeout(timer);
                dc.removeEventListener('bufferedamountlow', finish);
                reject(Error(`DataChannel closed: ${dc.readyState}`));
              }
            });
          }
        }

        try {
          for (let offset = 0; offset < totalBytes; offset += frameBytes) {
            const size = Math.min(frameBytes, totalBytes - offset);
            await waitBelowHigh(size);
            dc.send(size === frameBytes ? payload : new ArrayBuffer(size));
            sentBytes += size;
            peakBufferedBytes = Math.max(peakBufferedBytes, dc.bufferedAmount);
          }
          const end = `END|${id}`;
          await waitBelowHigh(end.length);
          dc.send(end);
          peakBufferedBytes = Math.max(peakBufferedBytes, dc.bufferedAmount);

          while (Date.now() < deadline) {
            const ack = window.ack;
            if (ack?.id === id) {
              if (ack.receivedBytes !== totalBytes) {
                throw Error(`receiver ACK count ${ack.receivedBytes} != ${totalBytes}`);
              }
              return { sentBytes, ackBytes: ack.receivedBytes, peakBufferedBytes, senderRates };
            }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          throw Error('overall ACK deadline exceeded');
        } finally {
          clearInterval(ticker);
        }
      }, {
        id,
        totalBytes,
        highWater: config.highWater,
        frameBytes: config.frameBytes,
        deadline,
      });
      const elapsedSeconds = await sender.evaluate(t => (performance.now() - t) / 1000, start);
      const receiverStats = await receiver.evaluate(() => ({
        runId,
        receivedBytes,
        expectedBytes,
        rates,
        visibility: document.visibilityState,
      }));
      if (result.ackBytes !== totalBytes || receiverStats.receivedBytes !== totalBytes ||
          receiverStats.expectedBytes !== totalBytes || receiverStats.runId !== id) {
        throw Error(`${label} exact-byte assertion failed: ${JSON.stringify({ result, receiverStats, totalBytes, id })}`);
      }
      if (result.peakBufferedBytes > config.highWater) {
        throw Error(`${label} high-water exceeded: ${result.peakBufferedBytes} > ${config.highWater}`);
      }
      return {
        label,
        totalBytes,
        elapsedSeconds: +elapsedSeconds.toFixed(2),
        meanMiBps: +(result.sentBytes / mib / elapsedSeconds).toFixed(2),
        chunkBytes: config.frameBytes,
        highWaterBytes: config.highWater,
        lowThresholdBytes: config.lowWater,
        ...result,
        receiver: receiverStats,
        selectedPair: await selectedPair(),
      };
    }

    const idlePair = await selectedPair();
    const warmup = await run('warmup', config.warmMiB * mib);
    const measured = await run('measured', config.measuredMiB * mib);
    console.log(JSON.stringify({
      browser: userAgent.includes('Edg/') ? 'Edge' : userAgent.includes('Chrome/') ? 'Chrome' : 'Chromium',
      executable,
      nodeExecutable: process.execPath,
      nodeVersion: process.version,
      profile: config,
      userAgent,
      topology: 'two independent browser processes on visible about:blank pages; same-machine host-host UDP; reliable ordered DataChannel; START/READY/END/ACK on that channel; unique run IDs; exact receiver byte assertions',
      warmup,
      measured,
      idlePair,
    }, null, 2));
  } finally {
    if (senderBrowser) await senderBrowser.close();
    if (receiverBrowser) await receiverBrowser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
