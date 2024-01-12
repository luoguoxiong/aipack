
// 资源异常 error.js

// 代码异常
const a = [{ a: 1 }, { a: [] }];
a.map((item) => {
  item.a.map((temp) => {
    console.log(temp);
  });
});
// ===============

// fetch 监听异常
// fetch("/api/abc", {
//   method: "get",
// }).then((res) => {
//   console.log(res);
// });
// ========================

// xmlhttp请求异常
// setTimeout(() => {
//   const xhr2 = new XMLHttpRequest();
//   xhr2.onreadystatechange = () => {};
//   xhr2.open("get", "/api/abc", true);
//   // xhr2.open("get", "/api/abc2", true);
//   xhr2.send();
// }, 100);
// ====================

// prmoise 异常
// const promiseTest = () => {
//   return new Promise((res, rej) => {
//     rej(2);
//   });
// };
// promiseTest().then((res) => {
//   console.log(res);
// });
export default {};
