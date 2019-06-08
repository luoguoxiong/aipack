import React, { Component } from 'react'
import './index.scss'
import isCheck from '../../static/img/isCheck.png'
import noCheck from '../../static/img/noCheck.png'
class AddressSet extends Component {
  render() {
    return (
      <div className="addressSetPage">
        <div className="addressHeader">修改地址</div>
        <div className="onePx_bottom">
          <input className="addressInput" placeHolder="姓名" />
        </div>
        <div className="onePx_bottom">
          <input className="addressInput" placeHolder="电话号码" />
        </div>
        <div className="onePx_bottom">
          <div className="chooseAddress">sds</div>
        </div>
        <div className="onePx_bottom">
          <input className="addressInput" placeHolder="详细地址" />
        </div>
        <div className="onePx_bottom">
          <div className="isDefaultAddress">
            设置默认地址
            <img src={isCheck} />
          </div>
        </div>
      </div>
    )
  }
}
export default AddressSet
