# FITLY Live runtime contract — implementation coordination

All HTTP prefix `/api/v1`; standard ApiResponse envelope. Pagination `{content,page,size,totalElements,totalPages}`. Dates ISO strings. States draft/scheduled/starting/live/reconnecting/ended/terminated/cancelled. `mode` public/rehearsal. Permissions: shop.livestream.read/manage/broadcast/moderate/report.read, livestream.session.read/terminate, livestream.report.read/process, livestream.shop.restrict.

Session DTO `{id,shopId,title,description,coverUrl,scheduledAt,state,mode,version,startedAt,endedAt,endReason,mediaStopStatus,pinnedProductId,pinnedMessageId,viewerCount,shop:{id,slug,name,logoUrl},isFollowing,productsCount}`; `mediaStopStatus` none/pending/confirmed/failed. List GET `/livestreams?page&size&q&state&shopId`; GET `/livestreams/:id`. Public lists only public sessions of approved shops; scheduled/active visible; detail terminal visible. Guest viewer key header `X-Guest-Key` UUID, generated client-side if guest; authenticated actor from token.

Products GET `/livestreams/:id/products?page&size&q`: page of `{productId,displayNumber,position,pinned,card:ProductCardResponse}`. Product detail/variants existing `/products/:slug`.

POST `/livestreams/:id/viewer-session` body `{}` -> `{admissionId,participantIdentity,token,serverUrl,expiresAt}` (LiveKit token subscribe only). POST `/livestreams/:id/heartbeat` body `{admissionId}` -> `{viewerCount}`. POST `/livestreams/:id/leave` body `{admissionId}`. POST `/livestreams/:id/source-grants` authenticated body `{productId,quantity}` -> `{id,sourceGrantId,sessionId,productId,shopId,quantity,eligibleUntil}`; binds buyer and quantity, only while live + public + active admission. POST `/livestreams/:id/likes` `{admissionId,count?:1..20}` aggregates real likes.

GET `/livestreams/:id/messages?after&size` -> array `{id,sequence,userId,displayName,body,replyToId,createdAt,deleted}`. POST same `/messages` body `{clientMessageId,body,replyToId?}` -> message (REST fallback and durable write). POST `/livestreams/:id/reports` authenticated body `{reason,description?}`. GET `/livestreams/:id/follow` -> `{following}`; POST same body `{following:boolean}` -> `{following}` (follows shop).

Socket.IO namespace `/live`, standard socket.io path, auth `{token?:accessJWT,sessionId,admissionId?,guestKey?}`. Server authenticates JWT via identity gateway + checks room admission. Receive `session.state_changed`, `product.pinned`, `message.accepted`, `message.deleted`, `viewer.count_changed`, `moderation.changed`, `campaign.updated`; payload `{sessionId,version?,...}`. Client emits `message.send` with `{clientMessageId,body,replyToId?}`, receives ack `{ok:true,data}` / `{ok:false,message}`. HTTP message remains available if socket down. Heartbeat REST every20s only while viewing.

Shop endpoints require ShopContextGuard:
- GET `/shop/livestreams?page&size&state&q` -> session page.
- POST `/shop/livestreams` `{title,description?,coverUrl?,scheduledAt?,productIds?:string[]}` -> session.
- PATCH `/shop/livestreams/:id` same optional fields + `{version:number}` -> session; only draft/scheduled.
- POST `/shop/livestreams/:id/cancel` `{version}` -> session.
- GET `/shop/livestreams/:id` -> session (own shop).
- GET `/shop/livestreams/:id/products?page&size&q` -> same page. GET `/shop/livestreams/product-options?page&size&q` -> ProductCardResponse page of own active products.
- PUT `/shop/livestreams/:id/products` `{productIds:string[],version}` -> session; ordered IDs ≤50; preserve stable displayNumber.
- POST `/shop/livestreams/:id/pin` `{productId:string|null,version}` -> session.
- POST `/shop/livestreams/:id/start` `{rehearsal?:boolean}` -> `{session:Session,token,serverUrl,participantIdentity,expiresAt}`; rehearsal=true clones into private rehearsal session when original public draft, ends test before public start.
- POST `/shop/livestreams/:id/host-token` `{}` -> same token shape with session; reconnect publisher owned by initiating host only.
- POST `/shop/livestreams/:id/end` `{reason?:string}` -> session; idempotent terminal.
- GET `/shop/livestreams/:id/messages` same as public, authenticated own shop.
- POST `/shop/livestreams/:id/moderation` `{action:'delete_message'|'pin_message'|'unpin_message'|'mute'|'unmute',messageId?,userId?,reason?}` -> `{ok:true}`.
- GET/PUT `/shop/livestreams/:id/moderators`; PUT body `{userIds}`; response `{userIds,candidates:[{userId,fullName}]}`. Candidates require active membership and effective moderation permission. Rehearsal clones moderator invitations from source; uninvited staff cannot enter private rehearsal.
- GET `/shop/livestreams/:id/report` -> `{session,views,uniqueViewers,peakViewers,messageCount,likes,productClicks}` plus commerce report root-owned fields if available. No fake revenue.

Platform:
- GET `/admin/livestreams?page&size&state&shopId&q` -> sessions page.
- GET `/admin/livestreams/:id` -> session.
- POST `/admin/livestreams/:id/terminate` `{reason}` -> session with mediaStopStatus.
- GET `/admin/livestream-reports?page&size&status` -> page `{id,sessionId,reason,description,status,createdAt}`.
- POST `/admin/livestream-reports/:id/process` `{decision:'dismissed'|'resolved',note?}` -> report.
- POST `/admin/livestreams/shops/:shopId/restrict` `{restricted:boolean,reason}` -> `{restricted}`.

Root owns promotion GET/POST `/shop/livestreams/:id/campaigns`, GET `/livestreams/:id/campaigns`, POST `/livestreams/:id/campaigns/:campaignId/claims`, intents/cart/provenance and voucher policy; coordinate exact DTOs with root. Core agent does not register duplicate campaign routes.

Final DTO additions: detail `pinnedProduct` is full `{productId,displayNumber,position,pinned,card}` even when outside current product page; `mediaAvailable` and `canModerate` are server calculated; `likes` actual persistent count. List accepts exact `shopSlug`. PATCH `coverUrl:null` / `scheduledAt:null` clears values. Shop report `.commerce` comes from actual order gateway; media/chat totals are persisted aggregates.

Discovery list accepts `categorySlug` (exact leaf category among active approved attached products); filtering happens before database pagination/count. `q` matches session title OR shop name; shop/category/state filters compose. Heartbeat rate120/min by actor/IP supports ten guest tabs behind one network while admission quota remains10.
