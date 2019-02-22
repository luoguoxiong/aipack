import React, {Component} from 'react'
import {Link} from 'react-router-dom'
import './index.scss'
import ImgLazyLoad from '../imgLazyLoad'
class GoodsList extends Component{
  render () {
    const { goodsList} = this.props
    return (
        <div className="goodsList">
          {goodsList.map((item) => {
            return(
              <Link to={`/goods/${item.id}`} key={item.id} className="goodsItem">
                <div className="goodsItemImg">
                  <ImgLazyLoad
                    offSetTop={44}
                    realUrl = {item.list_pic_url}>
                  </ImgLazyLoad>
                </div>
                <div className="goodsItemName">{item.name}</div>
                <div className="goodsItemPrice">￥{item.retail_price}元</div>
              </Link>
            )
          })}
        </div>
    )
  }
}
export default GoodsList
