/*
 * Gác RANH GIỚI MODULE bằng máy (AGENTS.md — Module Communication / Cross-Module Rule).
 *
 * Một module nghiệp vụ ở src/modules/<m>/ chỉ được import:
 *   - src/common/**, src/config/**          (nền tảng dùng chung)
 *   - chính nó
 *   - phần CÔNG KHAI của module khác: <khac>/queryapi/**, <khac>/applicationapi/**, <khac>/enums/**
 * Mọi thứ khác của module khác (repository, service, controller, dto, gateway impl…) là RUỘT — import là vi phạm.
 *
 * common không được import module nghiệp vụ nào. PrismaClient chỉ khởi tạo ở common/prisma; nơi khác dùng
 * PrismaService qua DI (được import TYPE `Prisma` từ generated để khai kiểu input).
 * Việc module chỉ được đụng MODEL của schema mình do `src/prisma-boundaries.spec.ts` gác (đọc *.prisma).
 */
const MODULE_DIR = '^src/modules/([^/]+)/';

module.exports = {
  forbidden: [
    {
      name: 'common-khong-import-module-nghiep-vu',
      severity: 'error',
      comment: 'common là nền tảng mỏng — không được phụ thuộc module nghiệp vụ nào.',
      from: { path: '^src/common/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'module-khong-import-ruot-module-khac',
      severity: 'error',
      comment:
        'Module A chỉ được dùng queryapi/applicationapi/enums của module B. Ghi chéo đi qua gateway ở common hoặc outbox.',
      from: { path: MODULE_DIR },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/queryapi/',
          '^src/modules/[^/]+/[^/]+\.module\.ts$',
          '^src/modules/[^/]+/applicationapi/',
          '^src/modules/[^/]+/enums/',
          '^src/modules/[^/]+/[^/]+/enums/',
        ],
      },
    },
    {
      name: 'chi-common-prisma-khoi-tao-client',
      severity: 'error',
      comment: 'PrismaClient chỉ khởi tạo ở common/prisma; nơi khác tiêm PrismaService, chỉ import TYPE từ generated.',
      from: { path: '^src/', pathNot: ['^src/common/prisma/', '^src/generated/'] },
      to: { path: '^src/generated/prisma/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'khong-vong-lap',
      severity: 'error',
      comment: 'Không cho phép import vòng.',
      from: { pathNot: '^src/generated/' },
      to: { circular: true, pathNot: '^src/generated/' },
    },
    {
      name: 'khong-orphan',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '\\.spec\\.ts$', '^src/(main|worker)\\.ts$', '^src/generated/'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', '^src/generated/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
