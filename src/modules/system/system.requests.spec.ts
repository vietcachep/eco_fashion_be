import { ValidationPipe } from '@nestjs/common';
import { UpdateSettingRequest } from './system.requests';

/* Cấu hình giống main.ts (whitelist + transform): thuộc tính không có decorator class-validator bị loại khỏi body. */
describe('UpdateSettingRequest qua ValidationPipe (whitelist)', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const run = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateSettingRequest }) as Promise<UpdateSettingRequest>;

  it.each([[48], [0], [true], [false], ['abc'], ['']])('giữ nguyên value = %p', async (value) => {
    expect((await run({ value })).value).toBe(value);
  });

  it('thiếu value ⇒ 400 thay vì lọt xuống service với undefined', async () => {
    await expect(run({})).rejects.toMatchObject({ status: 400 });
  });
});
