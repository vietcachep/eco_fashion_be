import { ReviewService } from './review.service';

/* Test quy tắc THUẦN của review. */
describe('review — che tên khách', () => {
  it('giữ họ, viết tắt phần còn lại', () => {
    expect(ReviewService.maskName('Nguyễn Văn An')).toBe('Nguyễn V. A.');
    expect(ReviewService.maskName('An')).toBe('An');
  });
});
