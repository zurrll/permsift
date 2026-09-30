import { executeSandboxNative, type BackendContext } from './backend.js';

const controller = new AbortController();
process.on('message', message => {
  if ((message as { type?: string }).type === 'cancel') controller.abort();
});
process.once('message', async message => {
  const input = message as { type: 'start'; command: string[]; context: BackendContext };
  if (input.type !== 'start') process.exit(2);
  try {
    await executeSandboxNative(input.command, { ...input.context, signal: controller.signal }, {
      onStart: pid => process.send?.({ type: 'task_start', pid }),
      onResult: result => process.send?.({ type: 'result', result }),
    });
    process.send?.({ type: 'finished' }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: 'error', error: String(error) }, () => process.exit(2));
  }
});
