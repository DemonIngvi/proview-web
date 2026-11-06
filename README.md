# proview-web

Демо-страница и браузерный **SDK** платформы ProView. SDK загружает баннеры в рекламные места страницы и отправляет статистику: показ, видимость, наведение с длительностью, клик и активное время. Образ — nginx без root-прав, с файловой системой только для чтения.

Часть платформы: [документация](https://github.com/DemonIngvi/proview-docs) · [развёртывание](https://github.com/DemonIngvi/proview-deploy).

## Подключение SDK

```html
<div data-proview-placement="home_top"></div>
<script>window.PROVIEW_CONFIG = { bannerEndpoint: "https://ads.example.com", collectorEndpoint: "https://events.example.com" };</script>
<script type="module" src="https://cdn.example.com/sdk/proview.js"></script>
```

Пустые адреса означают тот же origin: встроенный nginx проксирует `/v1/banner` и `/v1/events`. Ручной запуск: `PROVIEW_CONFIG.manual = true`, затем `import { init } from '/sdk/proview.js'; init()`.

## Что и как считает SDK

| Событие | Правило |
|---|---|
| `impression` | креатив загрузился (`img.onload`), один раз на показ |
| `viewable` | ≥ 50 % площади в окне ≥ 1 с подряд при видимой вкладке (IAB/MRC), один раз |
| `hover` | курсор ушёл с баннера. `duration_ms` = время над ним, учитывается от 100 мс |
| `click` | клик по креативу. События отправляются через `sendBeacon` до перехода |
| `active_time` | время, пока баннер виден на ≥ 50 % и вкладка активна. Отправляется дельтами каждые 5 с и при скрытии страницы |

Очередь событий:
- пакеты по показам (до 20 показов и 50 событий на показ), отправка раз в 2 с или при наполнении;
- `text/plain` без CORS-preflight;
- при `503`, `429` или сетевой ошибке повтор с экспоненциальной паузой с теми же `seq`, поэтому `event_id` стабилен;
- `4xx` не повторяется;
- очередь ограничена 500 событиями;
- при `pagehide` и `visibilitychange` отправка через `navigator.sendBeacon`.

Логика вынесена в чистые модули без DOM: `sdk/tracker.js` и `sdk/queue.js`. Они покрыты unit-тестами с фиктивными часами. `sdk/proview.js` — тонкий слой над DOM (IntersectionObserver, pointer-события, visibility).

## Контейнер

| Переменная | По умолчанию | |
|---|---|---|
| `BANNER_ENDPOINT` / `COLLECTOR_ENDPOINT` | пусто | попадают в `/config.js` |
| `BANNER_UPSTREAM` / `COLLECTOR_UPSTREAM` | `proview-banner-service:8080` / `proview-event-collector:8080` | цели прокси (keepalive-пулы, динамический DNS) |

Порты: `8080` — сайт, `9090` — `/healthz` и `/readyz`. Запуск возможен под любым UID с `--read-only` и записываемыми `/tmp` и `/etc/nginx/conf.d`. В Kubernetes их дают `emptyDir` из чарта. В продакшене статику и SDK лучше раздавать через CDN, а эти поды оставить источником.

## Разработка

```bash
npm test                    # unit-тесты SDK (node --test, без зависимостей)
docker build -t proview-web .
helm lint charts/proview-web --strict
```

Креативы в `public/banners/` — оригинальные SVG вымышленных брендов.

Лицензия: Apache-2.0.
