# tegg app

[Hacker News](https://news.ycombinator.com/) showcase using [tegg](https://github.com/eggjs/tegg)

## QuickStart

### Development

```bash
npm i
npm run dev
open http://localhost:7001/
```

Don't tsc compile at development mode, if you had run `tsc` then you need to `npm run clean` before `npm run dev`.

### Deploy

```bash
npm run tsc
npm start
```

### Npm Scripts

- Use `npm run lint` to check code style
- Use `npm test` to run unit test
- se `npm run clean` to clean compiled js at development mode once

### Requirement

- Node.js >= 16.x
- Typescript >= 4.x

## 用到的库
[egg-sequelize](https://github.com/eggjs/egg-sequelize)

[sequelize-cli](https://sequelize.org/docs/v7/cli/)

[kafka-node](https://github.com/SOHU-Co/kafka-node)

## 业务逻辑

1. 创建应用 -> 创建page_traffics_appId表、在redis缓存该应用status 1