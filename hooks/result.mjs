const { receive } = await import('../src/common/hooks/receiver.ts');
await receive('PostToolUse');
