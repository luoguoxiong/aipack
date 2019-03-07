/**
 * 防抖函数
 * @param func
 * @param wait 时间停止后多长时间触发
 * @returns {Function}
 */
export function debounce(func, wait) {
  let timeout = null
  return function() {
    let context = this, args = arguments;
    clearTimeout(timeout)
    timeout = setTimeout(function() {
      func.apply(context, args)
    }, wait)
  }
}

/**
 * 节流函数
 * @param func
 * @param wait
 * @param mustRun
 * @returns {Function}
 */
export  function throttle(func, wait=0, mustRun=1000/64) {
  let timeout, startTime = new Date()
  return function () {
    let context = this, args = arguments, curTime = new Date();
    clearTimeout(timeout)
    if(curTime - startTime >= mustRun){
      func.apply(context,args)
      startTime = curTime
    }else{
      timeout = setTimeout(function () {
        func.apply(context, args)
      }, wait)
    }
  }
}

/**
 * RAF节流
 * @param func
 * @returns {Function}
 */
export function rafThrottle(func){
  return function () {
    let ticking = false
    let args = arguments, context = this
    if(!ticking) {
      requestAnimationFrame(function () {
        func.apply(context, args)
        ticking = false
      });
      ticking = true
    }
  }
}
