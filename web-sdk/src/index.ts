import { onFID, onLCP, onFCP, onTTFB } from 'web-vitals/attribution';
import { _history } from './history';
import { generateShortUUID } from './utils';

export class Monitor {
  config: MonitorConfig;

  performance: PerfamceReportMsg;

  firstPageMsg: PageMsg;

  lastPageMsg: PageMsg;

  curPageStatus: PageStatus;

  reportStack: ReportItem[];

  markUserId: string;

  userId: string;

  constructor(config: MonitorConfig){
    this.config = config;
    const markUserId = window.localStorage.getItem(`web-watch-dog-markUserId-${this.config.appId}`);
    if(markUserId){
      this.markUserId = markUserId;
    }else{
      window.localStorage.setItem(`web-watch-dog-markUserId-${this.config.appId}`, generateShortUUID());
    }
    generateShortUUID();

    this.userId = window.localStorage.getItem(`web-watch-dog-userId-${this.config.appId}`);

    this.performance = {
      type: 'performance',
      dnsTime: -1,
      tcpTime: -1,
      whiteTime: -1,
      fcp: -1,
      ttfb: -1,
      lcp: -1,
      fid: -1,
    };

    this.firstPageMsg = {
      isFirst: true,
      pageUrl: location.hash || location.pathname,
      domain: location.host,
      query: location.search,
    };

    this.reportStack = [];

    this.caughtError();

    this.resetXmlHttp();

    this.resetFetch();

    this.catchRouterChange();

    this.lastPageMsg = this.getPageMsg();

    this.curPageStatus = {
      inTime: new Date().getTime(),
      leaveTime: 0,
      residence: 0,
    };

    const startTime = window.performance.now();
    window.addEventListener('load', async() => {
      const endTime = window.performance.now();
      this.performance.whiteTime = endTime - startTime;
      this.toReport({
        type: 'resource',
        ...this.firstPageMsg,
        rescources: this.getEnteries(),
      });
      await this.getWebPerformance();
    });

    window.addEventListener('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const getTagMsg = (tag) => {
        if(tag){
          const className = tag.getAttribute('class');
          const id = tag.getAttribute('id');
          const tagName = tag.tagName.toLocaleLowerCase();
          return `${tagName}${id ? `#${id}` : ''}${className ? `.${className}` : ''}`;
        }
      };

      const track = [getTagMsg(target)];
      let curTarget = event.target as any;
      while(curTarget && curTarget.parentNode !== document){
        track.unshift(getTagMsg(curTarget.parentNode));
        curTarget = curTarget.parentNode;
      }

      this.toReport({
        type: 'click',
        clickElement: track.join('>'),
        ...this.getPageMsg(),
      });
    }, true);

    window.onbeforeunload = () => {
      const { api } = this.config;
      const img = document.createElement('img');
      const curTime = new Date().getTime();
      this.reportStack.push({
        type: 'pageStatus',
        userTimeStamp: new Date().getTime(),
        markUserId: this.markUserId,
        userId: this.userId,
        ...this.lastPageMsg,
        ...{
          ...this.curPageStatus,
          leaveTime: curTime,
          residence: curTime - this.curPageStatus.inTime,
        },
      });
      img.src = `${api}?data=${encodeURIComponent(JSON.stringify(this.reportStack))}`;
    };
  }

  private getPageMsg = () => {
    const isHash = location.hash && location.hash !== '';
    return {
      pageUrl: isHash ? location.hash : location.pathname,
      domain: location.host,
      query: location.search,
    };
  };

  private catchRouterChange = () => {
    const dealWithPageInfo = () => {
      const curTime = new Date().getTime();
      const lastPageStatus = {
        ...this.curPageStatus,
        leaveTime: curTime,
        residence: curTime - this.curPageStatus.inTime,
      };
      this.curPageStatus = {
        inTime: curTime,
        leaveTime: 0,
        residence: 0,
      };
      this.toReport({
        type: 'pageStatus',
        ...this.lastPageMsg,
        ...lastPageStatus,
      });
      this.lastPageMsg = this.getPageMsg();
    };
    _history.addEventListener(() => {
      dealWithPageInfo();
    });
    window.addEventListener('hashchange', () => {
      dealWithPageInfo();
    });
  };

  private toReport(data: ReportItem){
    data.userTimeStamp = new Date().getTime();
    data.markUserId = this.markUserId;
    data.userId = this.userId;
    this.reportStack.push(data);
    const { api, cacheMax } = this.config;
    if(this.reportStack.length === cacheMax){
      const img = document.createElement('img');
      img.src = `${api}?data=${encodeURIComponent(JSON.stringify(this.reportStack))}`;
      this.reportStack = [];
    }
  }

  private async getWebPerformance() {
    const [{ domainLookupEnd, domainLookupStart, connectEnd, connectStart }] = window.performance.getEntriesByType('navigation');
    this.performance.dnsTime = domainLookupEnd - domainLookupStart;
    this.performance.tcpTime = connectEnd - connectStart;
    const getWebvitals = (fn: (data: any) => void): Promise<number> => new Promise((resolve) => {
      const timerId = setTimeout(() => {
        resolve(-1);
      }, this.config.webVitalsTimeouts);
      fn((data) => {
        clearTimeout(timerId);
        resolve(data.value);
      });
    });
    const [fcp, ttfp, lcp, fid] = await Promise.all([
      getWebvitals(onFCP),
      getWebvitals(onTTFB),
      getWebvitals(onLCP),
      getWebvitals(onFID),
    ]);
    this.performance.fcp = fcp;
    this.performance.ttfb = ttfp;
    this.performance.lcp = lcp;
    this.performance.fid = fid;
    this.toReport({
      type: 'performance',
      ...this.firstPageMsg,
      ...this.performance,
    });
  }

  private getEnteries() {
    const resources = window.performance.getEntriesByType('resource');
    return resources.map((item) => ({
      resource: item.name,
      duration: item.duration,
      size: item.decodedBodySize,
      type: item.initiatorType,
    }));
  }

  private caughtError() {
    const monitor = this;
    window.addEventListener(
      'error',
      (error: ErrorEvent | Event) => {
        if(error instanceof ErrorEvent){
          monitor.toReport({
            ...monitor.getPageMsg(),
            type: 'jsError',
            message: error.message,
            stack: error.error.stack,
            colno: error.colno,
            lineno: error.lineno,
            filename: error.filename,
          });
        }else{
          const { type, target } = error as any;
          monitor.toReport({
            ...monitor.getPageMsg(),
            type: 'loadResourceError',
            resourceType: type,
            resourceUrl: target.src,
          });
        }
      },
      true
    );

    window.addEventListener('unhandledrejection', (error) => {
      this.toReport({
        type: 'rejectError',
        reason: error.reason.toString(),
        ...monitor.getPageMsg(),
      });
    });
  }

  private resetXmlHttp() {
    if (!window.XMLHttpRequest) return;
    const xmlhttp = window.XMLHttpRequest;

    const monitor = this;

    const originOpen = xmlhttp.prototype.open;

    xmlhttp.prototype.open = function(...args) {
      const xml = this as XMLHttpRequest;
      const config: RequestReportMsg = {
        type: 'request',
        url: args[1],
        method: args[0],
        reqHeaders: '',
        reqBody: '',
        status: 0,
        requestType: 'done',
        cost: 0,
      };

      let startTime;

      const originSend = xml.send;

      const originSetRequestHeader = xml.setRequestHeader;

      const requestHeader = {};
      xml.setRequestHeader = function(key: string, val: string) {
        requestHeader[key] = val;
        return originSetRequestHeader.apply(xml, [key, val]);
      };

      xml.send = function(args: Document | XMLHttpRequestBodyInit){
        config.reqBody = JSON.stringify(args);
        return originSend.apply(xml, [args]);
      };

      xml.addEventListener('readystatechange', function(ev: Event){
        if(this.readyState === XMLHttpRequest.DONE){
          config.status = this.status;
          config.cost = performance.now() - startTime;
          config.reqHeaders = JSON.stringify(requestHeader);
          config.requestType = this.status === 0 ? 'error' : 'done';
          monitor.toReport({
            type: 'request',
            ...monitor.getPageMsg(),
            ...config,
          });
        }
      });
      xml.addEventListener('loadstart', function(data: ProgressEvent<XMLHttpRequestEventTarget>){
        startTime = performance.now();
      });
      xml.addEventListener('error', function(data: ProgressEvent<XMLHttpRequestEventTarget>){
        config.requestType = 'error';
        config.status = this.status;
        config.cost = performance.now() - startTime;
        config.reqHeaders = JSON.stringify(requestHeader);
        monitor.toReport({
          type: 'request',
          ...monitor.getPageMsg(),
          ...config,
        });
      });
      xml.addEventListener('timeout', function(data: ProgressEvent<XMLHttpRequestEventTarget>){
        config.requestType = 'timeout';
        config.status = this.status;
        config.cost = performance.now() - startTime;
        config.reqHeaders = JSON.stringify(requestHeader);
        monitor.toReport({
          type: 'request',
          ...monitor.getPageMsg(),
          ...config,
        });
      });
      return originOpen.apply(this, args);
    };
  }

  private resetFetch() {
    const _oldFetch = window.fetch;
    window.fetch = (...args) => {
      const [url, { method, headers, body }] = args;
      const startTime = performance.now();
      const data: RequestReportMsg = {
        type: 'request',
        url: url as string,
        method: method,
        reqHeaders: headers ? JSON.stringify(headers) : '',
        reqBody: body ? JSON.stringify(body) : '',
        status: 0,
        requestType: 'done',
        cost: 0,
      };
      return new Promise((resolve, reject) => {
        _oldFetch
          .apply(window, args)
          .then((res) => {
            const endTime = performance.now();
            data.cost = endTime - startTime;
            data.status = res.status;
            data.requestType = res.ok ? 'done' : 'error';
            this.toReport({
              type: 'request',
              ...this.getPageMsg(),
              ...data,
            });
            resolve(res);
          })
          .catch((error: any) => {
            const endTime = performance.now();
            data.cost = endTime - startTime;
            data.status = 0;
            data.requestType = 'error';
            this.toReport({
              type: 'request',
              ...this.getPageMsg(),
              ...data,
            });
            reject(error);
          });
      });
    };
  }

  public setUserId(userId: string){
    window.localStorage.setItem(`web-watch-dog-userId-${this.config.appId}`, userId);
  }
}

