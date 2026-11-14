# Deploy the MVP: S3 + CloudFront + ECS + SQLite

The React frontend is static, but it now calls FastAPI to store plans and sessions. Deploy the frontend build to S3/CloudFront and the backend Docker image to ECS. RDS is not required for this MVP.

## Resources and assets

| Resource or asset | Purpose |
| --- | --- |
| Private S3 bucket + CloudFront distribution + OAC | Serve the frontend over HTTPS |
| `frontend/dist/` contents | `index.html`, bundled JavaScript/CSS, and future public assets |
| Container registry, such as ECR | Store the image built from `backend/Dockerfile` |
| ECS cluster, task definition, service, and networking | Run the API on port 8000 |
| HTTPS API endpoint, typically an ALB with DNS/certificate | Let the HTTPS frontend call the backend |
| ECS execution role and logs | Pull the image and write application logs |
| Optional frontend custom domain, DNS, and ACM certificate | Custom hostname; CloudFront viewer certificates must be in `us-east-1` |

The browser must be able to reach the HTTPS API URL. An ECS service name or private task IP is not a public API URL. Do not place AWS credentials or other secrets in Vite environment variables: they are embedded in the public JavaScript.

## 1. Deploy the backend to ECS

Build/push the backend image to your registry, then reference that image in an ECS task definition. Map container port **8000** and configure these environment variables:

```env
DATABASE_URL=sqlite:////data/hifdh.db
AUTO_CREATE_SCHEMA=true
FRONTEND_URL=https://YOUR_FRONTEND_HOSTNAME
CORS_ORIGINS=https://YOUR_FRONTEND_HOSTNAME
```

`/data` is created and writable by the Dockerfile's non-root user. Leave that directory writable in the task configuration. `AUTO_CREATE_SCHEMA` creates the new anonymous tables on startup. For an existing database, it leaves the old account tables/data untouched; it does not import or convert them.

Use `/ready` for readiness/ALB health checks on port 8000. `/health` checks only that the process responds. Allow traffic from the load balancer security group to the task security group on 8000, and configure the ALB target group appropriately for your ECS networking mode (IP targets for Fargate/awsvpc).

Expose the API over HTTPS. For an ALB, its certificate belongs in the ALB's region. An HTTPS frontend cannot call an HTTP API because browsers block mixed content. Set `CORS_ORIGINS` to the exact frontend origin, with no trailing slash; comma-separate multiple origins if needed.

### SQLite limits for this first release

Keep **one ECS task** for this disposable-data demo. Multiple tasks would each have an independent SQLite database, so successive requests could see different data. Rolling replacements can also temporarily overlap old/new databases; do not assume zero-downtime releases preserve a consistent database.

On Fargate, task-local database files disappear when the task is stopped or replaced. The local Docker Compose named volume is not created or reused by ECS. Browser workspace keys remain, but an empty replacement database will have no plans for those keys. Use durable database storage before promising persistence across deployments; RDS can be introduced later.

## 2. Build the frontend with the API URL

Create `frontend/.env.local` with the public API base URL, without `/api/v1`:

```env
VITE_API_URL=https://api.example.com
```

From `frontend/`:

```sh
npm ci
node --test tests/api.test.js
npm run build
npm run preview
```

Vite embeds the API URL at **build time**. Changing an ECS environment variable will not change the built frontend; rebuild/re-upload after changing `VITE_API_URL`.

If you later route `/api/*` through CloudFront to the ALB instead, set `VITE_API_URL` to the frontend origin. Configure that behavior to allow all API methods, forward `X-Workspace-Key`, `Idempotency-Key`, `Content-Type`, and query strings, and disable caching. Keep this separate from the S3 asset behavior. The API also sends `Cache-Control: no-store`.

## 3. Configure S3 and CloudFront

1. Create a private S3 bucket with all Block Public Access settings enabled.
2. Create a CloudFront distribution using the regular S3 bucket endpoint as origin, with OAC signing enabled. S3 static website hosting is not needed.
3. Apply the generated bucket policy granting `cloudfront.amazonaws.com` permission for `s3:GetObject`, restricted by `AWS:SourceArn` to your distribution ARN.
4. Set the default root object to `index.html`, without a leading slash.
5. Redirect HTTP to HTTPS. Allow GET/HEAD and enable compression for frontend assets.
6. Create an asset cache policy with minimum TTL **0**, default TTL **0**, maximum TTL **31536000**, compression enabled, and no headers, cookies, or query strings in the cache key. This respects the upload cache headers without forwarding the viewer Host header to S3.
7. Use the CloudFront hostname or configure your custom domain/DNS and its ACM certificate in `us-east-1`.

The UI uses `/` and `#home`, so no frontend SPA path rewrites are currently required. Fonts load from Google Fonts with system fallbacks; icons are bundled.

## 4. Upload the frontend

Run from `frontend/` after building. Replace the bucket and distribution ID:

```sh
aws s3 sync dist/assets/ s3://YOUR_BUCKET/assets/ --cache-control 'public,max-age=31536000,immutable'
aws s3 cp dist/index.html s3://YOUR_BUCKET/index.html --content-type 'text/html' --cache-control 'no-cache'
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths '/index.html' '/'
```

Upload only build output, not source, `.env` files, `node_modules`, Python files, database files, or AWS credentials. If future builds include public files outside `assets/`, upload those too.

Upload assets before HTML and keep old hashed assets available for visitors with an older page open. Do not use `--delete` for these uploads.

## 5. Verify

- The frontend opens without a login screen.
- API `/health` and `/ready` return 200.
- Creating a plan and logging a session generates successful HTTPS API requests with `X-Workspace-Key`.
- Refreshing the page reloads saved plans and sessions from the API.
- Another browser/private window gets an empty, separate workspace.
- There are no calls to localhost or `/api/v1/auth/*` in the deployed app.
- Direct anonymous S3 access is denied; CloudFront succeeds.

## Anonymous workspace behaviour

Each browser generates a random 256-bit key and stores it in localStorage. The API stores only the key's SHA-256 digest as the owner ID. Anyone with the key can access that workspace; do not log or share the header. There is no account recovery or automatic device sync. Clearing browser storage or changing frontend hostname creates a new workspace. CORS controls browser origins; it is not user authentication.

Older browser-only data under `hifdh-workspace-v1` is preserved but not automatically imported. Older account data also remains untouched in its original database tables.

## AWS references

- [Restrict S3 access with CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [CloudFront default root object](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DefaultRootObject.html)
- [CloudFront certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)
- [ECS bind mounts and task storage lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html)
