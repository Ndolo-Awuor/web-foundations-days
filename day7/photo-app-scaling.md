# Day 7: Scaling SnapShare

SnapShare lets users upload photos and scroll a feed of photos from people they
follow. This plan estimates demand and explains how the main components work
together as the app grows.

## 1. Assumptions

- There are **10 million registered users**, and **10% are active each day**.
- Each active user uploads **1 original photo per day** and views **50 feed
  pages per day**. One feed-page view means one feed API request, although that
  page can cause several separate image requests.
- An original photo averages **2 MB**, and one thumbnail adds **50 KB**.
- Use decimal storage units: 1 MB = 1,000 KB, 1 TB = 1,000,000 MB, and
  1 PB = 1,000 TB. Each original plus its thumbnail therefore uses **2.05 MB**.
- Use **86,400 seconds per day**, **365 days per year**, and a peak request rate
  of **5 times the daily average** for both uploads and feed views.
- Daily activity stays constant for this estimate, and photos are kept for
  the whole year without deletion. The annual estimate is new photo storage
  added in one year, starting from zero stored photos.
- Storage estimates exclude database metadata, indexes, storage-provider
  redundancy, backups, logs, temporary processing files and CDN/cache copies;
  actual provisioned storage and costs will be higher.
- This is an initial design, not a measured capacity guarantee: load tests must
  determine app-server sizes, worker counts and database capacity.

## 2. Traffic and storage estimates

### Daily active users

10,000,000 x 10% = **1,000,000 daily active users**.

### Upload and feed request rates

| Activity | Requests per day | Average per second | Peak per second (5x average) |
| --- | ---: | ---: | ---: |
| Photo uploads | 1,000,000 x 1 = 1,000,000 | 1,000,000 / 86,400 = 11.57 | 5,000,000 / 86,400 = 57.87 |
| Feed-page views | 1,000,000 x 50 = 50,000,000 | 50,000,000 / 86,400 = 578.70 | 250,000,000 / 86,400 = 2,893.52 |

Rounded up, plan initially for **12 uploads/second and 579 feed views/second
on average**, with **58 uploads/second and 2,894 feed views/second at peak**,
then allow capacity headroom. Peak figures are calculated from the unrounded
averages. These are API request rates, not exact database-operation counts.

The classroom shortcut of 100,000 seconds per day gives rough averages of
10 uploads/second and 500 feed views/second; the table uses the exact day length.

### Photo storage added per year

| Data | Added per day | Added per year (365 days) |
| --- | ---: | ---: |
| Original photos | 1,000,000 x 2 MB = 2,000,000 MB = 2 TB | 730 TB |
| Thumbnails | 1,000,000 x 0.05 MB = 50,000 MB = 0.05 TB | 18.25 TB |
| **Total** | **2.05 TB** | **748.25 TB = 0.74825 PB** |

Cross-check: 365,000,000 photos/year x 2.05 MB/photo = 748,250,000 MB/year.
Continued retention adds approximately this much again each year if usage stays
constant. We cannot estimate image download traffic from the supplied facts
alone because the number and size of images displayed per feed page are unknown.

## 3. Read-heavy or write-heavy?

SnapShare is **read-heavy by API request count**: 50,000,000 feed views divided
by 1,000,000 uploads is **50 feed reads for every upload**. Image downloads add
even more reads, while the original uploads still require substantial bandwidth
and storage. This ratio does not mean every API request performs just one
database operation.

Use a CDN for frequently viewed photo files, Redis for frequently requested
feed data, and a database read replica for feed queries that miss the cache.
Keep app servers stateless so any server behind the load balancer can handle
the next request. Durable data belongs in shared storage rather than one app
server's memory, and authentication must work across all app servers.

### Where photos belong

Store original photos and thumbnails in **object storage**, not as image bytes
inside the relational database. At this volume, large image blobs would enlarge
the database, backups and replication traffic and compete with feed queries.
Object storage suits large files and can act as the CDN's origin. The database
stores smaller records such as users, follow relationships, captions, ownership,
upload times, processing status and the object keys that locate photo files.

## 4. Architecture diagram

```text
API path (upload requests and feed requests):

[Client: browser or phone]
            |
            v
     [Load balancer]
            |
            v
 [Stateless app servers A, B, ...]
      |            |                  |
      |            |                  +-- writes --> [Primary database]
      |            |                                      |
      |            |                               replication
      |            |                                      v
      |            +-- feed cache miss --> [Database read replica]
      |
      +-- cache lookup / invalidation --> [Redis feed cache]
      |
      +-- store originals --> [Object storage: originals + thumbnails]
      |
      +-- thumbnail jobs --> [Queue] --> [Thumbnail worker(s)]
                                              |
                    +-------------------------+---------------------+
                    |                         |                     |
                    v                         v                     v
            [Object storage]          [Primary database]      [Redis cache]
          read original, write         mark photo ready       invalidate feeds
              thumbnail

Image delivery path (separate from feed JSON):

[Client] -- requests image --> [CDN edge near user]
                                      |
                               cache miss fetch
                                      v
                    [Object storage: image origin]
```

The primary database replicates to the read replica; the replica does not accept
application writes. Object storage sends image bytes to the CDN on a cache miss,
and the CDN returns cached or fetched bytes to the client.

### What each component solves

| Component | Problem it solves |
| --- | --- |
| Client | Provides the screen for selecting an upload and displaying feed data and images. |
| CDN | Caches photo files near users to reduce image latency and requests to object storage. |
| Load balancer | Spreads API requests across healthy app servers so one server does not handle all traffic. |
| Stateless app servers | Handle authentication, upload coordination and feed logic while allowing servers to be added or replaced without losing lasting user data. |
| Redis feed cache | Reuses recently requested feed data to reduce repeated database reads and improve response times. |
| Primary database | Stores authoritative user, follow and photo metadata and handles all metadata writes. |
| Database read replica | Handles suitable feed reads to reduce read pressure on the primary database. |
| Object storage | Holds large original photos and thumbnails without filling the metadata database with image bytes. |
| Queue | Buffers thumbnail jobs so upload requests do not wait for image processing and workers can absorb bursts. |
| Thumbnail workers | Process queued originals into thumbnails independently of the servers answering user requests. |

## 5. Upload flow, step by step

1. A signed-in user such as **Judith Kerubo** selects a photo and submits the
   upload through the load balancer to an available app server.
2. The app server checks authentication, ownership, file size and actual image
   type, rejecting invalid uploads before accepting them.
3. The app server stores the original in object storage with a unique object
   key; it does not store the image bytes in the database.
4. The app server writes a photo metadata record to the primary database with
   status `processing`, along with a pending thumbnail-job record in the same
   database transaction. This pending-job record is an **outbox**: it lets the
   app retry publishing the job if the queue is temporarily unavailable.
5. An app-server background task sends pending jobs to the queue and marks
   each one published after the queue acknowledges it. An accepted upload can
   receive `202 Accepted` with a photo ID and processing status while this work
   continues; the original and pending job have already been saved durably.
6. A thumbnail worker takes a job, reads the original from object storage,
   creates the 50 KB thumbnail on average, and saves it under a predictable,
   versioned thumbnail key in object storage.
7. The worker updates the primary database with the thumbnail key and status
   `ready`, invalidates affected cached feeds, then acknowledges the queue job.
   Make this processing idempotent, so a retried job for the same photo/version
   safely repeats its writes rather than creating duplicate photo records.
8. The client checks processing status through the API and sees the photo when
   it is ready. The normal feed includes only ready photos; it checks Redis
   first and uses the read replica on a cache miss, returning image URLs.
9. The client requests those images from the CDN. The CDN serves a cached copy
   or fetches it from object storage and caches it for later requests.

Use a short cache expiry as a fallback for missed invalidations. A read replica
can lag behind the primary, so the uploader's immediate status check should read
the primary, and a feed just invalidated after a write should briefly bypass the
replica and read the primary to avoid caching an older result. Followers may see
the new photo after a short delay. Workers should retry temporary failures;
repeated failures need a failed-job destination and an alert. Failed uploads may
also leave orphaned objects, which a cleanup task can remove after checking that
no valid metadata record references them.

## 6. Trade-offs

1. **Caching speed versus freshness:** Redis and the CDN make repeated reads
   faster, but cached results can become stale, so invalidate affected feed
   entries and use expiry times; versioned image URLs allow long CDN caching
   without serving an old thumbnail after an image changes.
2. **Read capacity versus immediate consistency:** a read replica adds read
   capacity and isolates feed traffic, but replication lag can briefly hide new
   changes, so route reads requiring the latest write to the primary at the
   cost of extra primary load.
3. **Fast uploads versus processing delay:** queued thumbnails keep upload
   responses quick and smooth bursts, but users see a processing state and the
   system needs retries, monitoring and duplicate-safe workers.
4. **Separate file storage versus extra coordination:** object storage and a
   CDN keep large photos out of the database and serve them efficiently, but
   object writes and database transactions are separate, so failures require
   cleanup and careful handling of photo status.

## 7. How to grow and verify the design

- Add app servers behind the load balancer when request latency, CPU or active
  connections show pressure; verify that they share no required local state.
- Add thumbnail workers when queue depth or the oldest job's waiting time rises,
  rather than tying thumbnail capacity to the number of app servers.
- Monitor feed latency, cache hit rate, database query time and replication lag
  before increasing cache capacity or adding further read replicas.
- Load-test at least the estimated 5x peak, check behavior when an app server
  fails, and test queue retries and delayed replication; adjust capacity using
  measured results and leave headroom for growth.
