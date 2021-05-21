/* eslint-disable no-console, @typescript-eslint/no-unused-vars */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from 'playwright-core'
import { Event } from 'jest-circus'
import type {
  BrowserType,
  ConfigDeviceType,
  ConfigParams,
  GenericBrowser,
  JestPlaywrightConfig,
  JestPlaywrightProjectConfig,
  Nullable,
  Playwright,
  TestPlaywrightConfigOptions,
} from '../types/global'
import {
  CHROMIUM,
  CONFIG_ENVIRONMENT_NAME,
  DEFAULT_CONFIG,
  FIREFOX,
  IMPORT_KIND_PLAYWRIGHT,
  PERSISTENT,
  LAUNCH,
  PLAYWRIGHT_CLIENT,
} from './constants'
import {
  checkDevice,
  deepMerge,
  formatError,
  getBrowserOptions,
  getBrowserType,
  getDeviceBrowserType,
  getPlaywrightInstance,
} from './utils'
import { saveCoverageOnPage, saveCoverageToFile } from './coverage'

const handleError = (error: Error): void => {
  process.emit('uncaughtException', error)
}

const getBrowserPerProcess = async (
  playwrightInstance: GenericBrowser,
  browserType: BrowserType,
  config: JestPlaywrightConfig,
): Promise<Browser | BrowserContext> => {
  const { launchType, userDataDir, launchOptions, connectOptions } = config

  if (
    launchType === LAUNCH ||
    launchType === PERSISTENT ||
    launchType === PLAYWRIGHT_CLIENT
  ) {
    // https://github.com/mmarkelov/jest-playwright/issues/42#issuecomment-589170220
    if (browserType !== CHROMIUM && launchOptions?.args) {
      launchOptions.args = launchOptions.args.filter(
        (item: string) => item !== '--no-sandbox',
      )
    }

    const options = getBrowserOptions(browserType, launchOptions)

    if (launchType === LAUNCH || launchType === PLAYWRIGHT_CLIENT) {
      return playwrightInstance.launch(options)
    }

    if (launchType === PERSISTENT) {
      return playwrightInstance.launchPersistentContext(userDataDir!, options)
    }
  }

  const options = getBrowserOptions(browserType, connectOptions)
  return playwrightInstance.connect(options)
}

const getDeviceConfig = (
  device: Nullable<ConfigDeviceType> | undefined,
  availableDevices: Playwright['devices'],
): BrowserContextOptions => {
  if (device) {
    if (typeof device === 'string') {
      const { defaultBrowserType, ...deviceProps } = availableDevices[device]
      return deviceProps
    } else {
      const { name, defaultBrowserType, ...deviceProps } = device
      return deviceProps
    }
  }
  return {}
}

const getDeviceName = (
  device: Nullable<ConfigDeviceType>,
): Nullable<string> => {
  let deviceName: Nullable<string> = null
  if (device != null) {
    if (typeof device === 'string') {
      deviceName = device
    } else {
      deviceName = device.name
    }
  }
  return deviceName
}

export const getPlaywrightEnv = (basicEnv = 'node'): unknown => {
  const RootEnv = require(basicEnv === 'node'
    ? 'jest-environment-node'
    : 'jest-environment-jsdom')

  return class PlaywrightEnvironment extends RootEnv {
    readonly _config: JestPlaywrightProjectConfig
    _jestPlaywrightConfig!: JestPlaywrightConfig

    constructor(config: JestPlaywrightProjectConfig) {
      super(config)
      this._config = config
    }

    _getContextOptions(devices: Playwright['devices']): BrowserContextOptions {
      const { browserName, device } = this._config
      const browserType = getBrowserType(browserName)
      const { contextOptions } = this._jestPlaywrightConfig
      const deviceBrowserContextOptions = getDeviceConfig(device, devices)
      const resultContextOptions = deepMerge(
        deviceBrowserContextOptions,
        getBrowserOptions(browserName, contextOptions),
      )
      if (browserType === FIREFOX && resultContextOptions.isMobile) {
        console.warn(formatError(`isMobile is not supported in ${FIREFOX}.`))
        delete resultContextOptions.isMobile
      }
      return resultContextOptions
    }

    _getSeparateEnvBrowserConfig(
      isDebug: boolean,
      config: TestPlaywrightConfigOptions,
    ): JestPlaywrightConfig {
      const { debugOptions } = this._jestPlaywrightConfig
      const defaultBrowserConfig: JestPlaywrightConfig = {
        ...DEFAULT_CONFIG,
        launchType: LAUNCH,
      }
      let resultBrowserConfig: JestPlaywrightConfig = {
        ...defaultBrowserConfig,
        ...config,
      }
      if (isDebug) {
        if (debugOptions) {
          resultBrowserConfig = deepMerge(resultBrowserConfig, debugOptions)
        }
      } else {
        resultBrowserConfig = deepMerge(
          this._jestPlaywrightConfig,
          resultBrowserConfig,
        )
      }
      return resultBrowserConfig
    }

    _getSeparateEnvContextConfig(
      isDebug: boolean,
      config: TestPlaywrightConfigOptions,
      browserName: BrowserType,
      devices: Playwright['devices'],
    ): BrowserContextOptions {
      const { device, contextOptions } = config
      const { debugOptions } = this._jestPlaywrightConfig
      const deviceContextOptions: BrowserContextOptions = getDeviceConfig(
        device,
        devices,
      )
      let resultContextOptions: BrowserContextOptions = contextOptions || {}
      if (isDebug) {
        if (debugOptions?.contextOptions) {
          resultContextOptions = deepMerge(
            resultContextOptions,
            debugOptions.contextOptions!,
          )
        }
      } else {
        resultContextOptions = deepMerge(
          this._jestPlaywrightConfig.contextOptions!,
          resultContextOptions,
        )
      }
      resultContextOptions = deepMerge(
        deviceContextOptions,
        resultContextOptions,
      )
      return getBrowserOptions(browserName, resultContextOptions)
    }

    async _setNewPageInstance(context = this.global.context) {
      const { exitOnPageError } = this._jestPlaywrightConfig
      const page = await context.newPage()
      if (exitOnPageError) {
        page.on('pageerror', handleError)
      }
      return page
    }

    async _setCollectCoverage(context: BrowserContext) {
      await context.exposeFunction('reportCodeCoverage', saveCoverageToFile)
      await context.addInitScript(() =>
        window.addEventListener('beforeunload', () => {
          // @ts-ignore
          reportCodeCoverage(window.__coverage__)
        }),
      )
    }

    async setup(): Promise<void> {
      const { wsEndpoint, browserName, testEnvironmentOptions } = this._config
      this._jestPlaywrightConfig = testEnvironmentOptions[
        CONFIG_ENVIRONMENT_NAME
      ] as JestPlaywrightConfig
      const {
        connectOptions,
        collectCoverage,
        selectors,
        launchType,
        skipInitialization,
        playwrightClientEndpointUrl,
      } = this._jestPlaywrightConfig
      if (wsEndpoint) {
        this._jestPlaywrightConfig.connectOptions = {
          ...connectOptions,
          wsEndpoint,
        }
      }
      const browserType = getBrowserType(browserName)
      const device = this._config.device
      const deviceName: Nullable<string> = getDeviceName(device)
      const {
        name,
        instance: playwrightInstance,
        devices,
        service,
      } = await getPlaywrightInstance(browserType, this._jestPlaywrightConfig)
      const contextOptions = this._getContextOptions(devices)

      if (name === IMPORT_KIND_PLAYWRIGHT && selectors) {
        const playwright = require('playwright')
        await Promise.all(
          selectors.map(({ name, script }) =>
            playwright.selectors
              .register(name, script)
              .catch((e: Error): void => {
                if (!e.toString().includes('has been already')) {
                  throw e
                }
              }),
          ),
        )
      }

      this.global.browserName = browserType
      this.global.deviceName = deviceName
      if (!skipInitialization) {
        const browserOrContext = await getBrowserPerProcess(
          playwrightInstance as GenericBrowser,
          browserType,
          this._jestPlaywrightConfig,
        )
        this.global.service = service
        this.global.browser =
          launchType === PERSISTENT ? null : browserOrContext
        this.global.context =
          launchType === PERSISTENT
            ? browserOrContext
            : await this.global.browser.newContext(contextOptions)
        if (collectCoverage) {
          await this._setCollectCoverage(this.global.context as BrowserContext)
        }
        this.global.page = await this._setNewPageInstance()
      }
      this.global.jestPlaywright = {
        configSeparateEnv: async (
          config: TestPlaywrightConfigOptions,
          isDebug = false,
        ): Promise<ConfigParams> => {
          const { device } = config
          const browserName =
            config.useDefaultBrowserType && device
              ? getDeviceBrowserType(device, devices) || CHROMIUM
              : config.browser || browserType
          const deviceName = device ? getDeviceName(device) : null
          checkDevice(deviceName, devices)
          const resultBrowserConfig: JestPlaywrightConfig =
            this._getSeparateEnvBrowserConfig(isDebug, config)
          const resultContextOptions: BrowserContextOptions =
            this._getSeparateEnvContextConfig(
              isDebug,
              config,
              browserName,
              devices,
            )
          const { instance, service: newInstanceService } =
            await getPlaywrightInstance(browserName, this._jestPlaywrightConfig)
          const browser = await getBrowserPerProcess(
            instance as GenericBrowser,
            browserName,
            resultBrowserConfig,
          )
          if (launchType && [PLAYWRIGHT_CLIENT, LAUNCH].includes(launchType)) {
            ;(browser as Browser).on('disconnected', () =>
              newInstanceService.close(),
            )
          }
          const context = await (browser as Browser)!.newContext(
            resultContextOptions,
          )
          const page = await context!.newPage()
          return { browserName, deviceName, browser, context, page }
        },
        resetPage: async (): Promise<void> => {
          await this.global.page?.close()
          this.global.page = await this._setNewPageInstance()
        },
        resetContext: async (
          newOptions?: BrowserContextOptions,
        ): Promise<void> => {
          const { browser, context } = this.global
          await context?.close()

          const newContextOptions = newOptions
            ? deepMerge(contextOptions, newOptions)
            : contextOptions

          this.global.context = await browser.newContext(newContextOptions)
          this.global.page = await this._setNewPageInstance()
        },
        resetBrowser: async (
          newOptions?: BrowserContextOptions,
        ): Promise<void> => {
          const { browser } = this.global
          await browser?.close()

          this.global.browser = await getBrowserPerProcess(
            playwrightInstance as GenericBrowser,
            browserType,
            this._jestPlaywrightConfig,
          )

          const newContextOptions = newOptions
            ? deepMerge(contextOptions, newOptions)
            : contextOptions

          this.global.context = await this.global.browser.newContext(
            newContextOptions,
          )
          this.global.page = await this._setNewPageInstance()
        },
        saveCoverage: async (page: Page): Promise<void> =>
          saveCoverageOnPage(page, collectCoverage),
      }
    }

    async handleTestEvent(event: Event) {
      const { browserName } = this._config
      const { collectCoverage, haveSkippedTests } = this._jestPlaywrightConfig
      const browserType = getBrowserType(browserName)
      if (haveSkippedTests && event.name === 'test_fn_start') {
        const { instance, devices } = await getPlaywrightInstance(
          browserType,
          this._jestPlaywrightConfig,
        )
        const contextOptions = this._getContextOptions(devices)
        this.global.browser = await getBrowserPerProcess(
          instance as GenericBrowser,
          browserType,
          this._jestPlaywrightConfig,
        )
        this.global.context = await this.global.browser.newContext(
          contextOptions,
        )
        if (collectCoverage) {
          await this._setCollectCoverage(this.global.context)
        }
        this.global.page = await this._setNewPageInstance()
      }
    }

    async teardown(): Promise<void> {
      const { browser, context, page, service } = this.global
      const { collectCoverage } = this._jestPlaywrightConfig
      page?.removeListener('pageerror', handleError)
      if (collectCoverage) {
        await Promise.all(
          (context as BrowserContext).pages().map((p) =>
            p.close({
              runBeforeUnload: true,
            }),
          ),
        )
        // wait until coverage data was sent successfully to the exposed function
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      await browser?.close()
      await service?.close()

      await super.teardown()
    }
  }
}

export default getPlaywrightEnv()
