class HistoryListener{
  deeps: Array<Listener> = [];

  constructor(){
    const methods = ['back', 'forward', 'go', 'pushState', 'replaceState'];
    methods.forEach((name: keyof Historys) => {
      this.registListner(name);
    });
  }

  notify(){
    this.deeps.forEach((listener: Listener) => listener());
  }

  registListner = (name: keyof Historys) => {
    const method = history[name];
    const _this = this;
    history[name] = function(...args: any[]) {
      method.apply(history, args);
      _this.notify();
    };
  };

  addEventListener(listner: Listener){
    this.deeps.push(listner);
    window.addEventListener('popstate', listner, false);
  }

  removeEventListener(listner: Listener){
    let i = 0;
    while(i < this.deeps.length){
      if(this.deeps[i] === listner){
        this.deeps.splice(i, 1);
        window.removeEventListener('popstate', listner);
        break;
      }
      i++;
    }
  }
}

export const _history = (() => {
  let constancs: HistoryListener;
  return () => constancs = constancs ? constancs : new HistoryListener();
})()();
