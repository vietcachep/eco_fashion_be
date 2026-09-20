-- Prisma không biểu diễn được index HNSW (pgvector) → migrate diff báo lệch. Bỏ index; quy mô đề tài quét tuần tự là đủ.
-- Khi > vài nghìn sản phẩm: tạo lại NGOÀI Prisma và ghi vào docs/03 (chấp nhận lệch có chủ đích) hoặc chờ Prisma hỗ trợ.
DROP INDEX IF EXISTS "ai"."idx_product_embeddings_hnsw";
DROP INDEX IF EXISTS "ai"."idx_document_chunks_hnsw";
