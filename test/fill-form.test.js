import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Isolate the CLI function without running GitHub, Gemini, or email requests.
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const fillFormSource = source.slice(
  source.indexOf('async function fillForm('),
  source.indexOf('\n// === Email'),
);

function setup(fail = () => false) {
  const calls = [];
  let attempt = 0;
  const step = async (operation, ...args) => {
    calls.push({ attempt, operation, args });
    if (fail(operation, attempt, ...args)) throw new Error(`failed: ${operation}`);
  };
  const locator = selector => ({
    contentFrame: () => frame,
    first: () => locator(selector),
    waitFor: options => step('waitFor', selector, options),
    fill: value => step('fill', selector, value),
    selectOption: value => step('selectOption', selector, value),
    click: () => step('click', selector),
  });
  const frame = { locator, getByRole: role => locator(role) };
  const fillForm = vm.runInNewContext(`(${fillFormSource})`, {
    config: {
      headless: true,
      reportUrl: 'https://example.test',
      reportEmail: 'user@example.test',
      reportDept: 'dept',
      reportName: 'name',
      categories: [
        { name: 'one', field: '#content-1' },
        { name: 'two', field: '#content-2' },
      ],
    },
    console: { log() {}, error() {} },
    delay: ms => step('delay', ms),
    chromium: {
      async launch() {
        attempt++;
        await step('launch');
        return {
          close: () => step('close'),
          async newContext() {
            await step('newContext');
            return {
              newPage: async () => ({
                locator,
                goto: (...args) => step('goto', ...args),
                waitForTimeout: ms => step('waitForTimeout', ms),
              }),
            };
          },
        };
      },
    },
  });
  return { calls, run: () => fillForm({ one: 'summary one', two: 'summary two' }) };
}

test('success waits up to 60 seconds for the form and does not retry', async () => {
  const { calls, run } = setup();
  await run();
  assert.equal(calls.filter(c => c.operation === 'launch').length, 1);
  assert.equal(calls.filter(c => c.operation === 'close').length, 1);
  assert.equal(calls.filter(c => c.operation === 'delay').length, 0);
  assert.equal(calls.find(c => c.operation === 'waitFor' && c.args[0] === '#content-1').args[1].timeout, 60000);
});

for (const failure of ['launch', 'newContext', 'load', 'partial fill', 'save']) {
  test(`retries ${failure} failure with a fresh browser and identical content`, async () => {
    const { calls, run } = setup((operation, attempt, selector) => attempt === 1 && (
      operation === failure ||
      (failure === 'load' && operation === 'waitFor' && selector === '#content-1') ||
      (failure === 'partial fill' && operation === 'fill' && selector === '#content-2') ||
      (failure === 'save' && operation === 'waitFor' && selector.startsWith('text='))
    ));
    await run();
    assert.equal(calls.filter(c => c.operation === 'launch').length, 2);
    assert.equal(calls.filter(c => c.operation === 'close').length, failure === 'launch' ? 1 : 2);
    const delayIndex = calls.findIndex(c => c.operation === 'delay');
    assert.equal(calls[delayIndex].args[0], 10000);
    if (failure !== 'launch') assert.equal(calls[delayIndex - 1].operation, 'close');
    const writes = calls.filter(c => c.operation === 'fill' && c.args[0].startsWith('#content-'));
    for (const write of writes) {
      assert.equal(write.args[1], write.args[0] === '#content-1' ? 'summary one' : 'summary two');
    }
    assert.equal(writes.filter(c => c.attempt === 2).length, 2);
  });
}

test('stops after three failures, closes browsers, and propagates the error', async () => {
  const { calls, run } = setup((operation, attempt, selector) => operation === 'waitFor' && selector === '#content-1');
  await assert.rejects(run, error => error.message.includes('3') && error.cause.message === 'failed: waitFor');
  assert.equal(calls.filter(c => c.operation === 'launch').length, 3);
  assert.equal(calls.filter(c => c.operation === 'close').length, 3);
  assert.equal(calls.filter(c => c.operation === 'delay').length, 2);
  assert.equal(calls.filter(c => c.operation === 'fill' && c.args[0].startsWith('#content-')).length, 0);
});
