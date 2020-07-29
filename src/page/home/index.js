import React, { Component, Fragment } from "react";
import "./index.scss";
import { connect } from "react-redux";
import { bindActionCreators } from "redux";
import * as homeAction from "../../redux/actions/home";
import { Carousel } from "antd-mobile";
import LazyLoad from "react-lazyload";
import morePng from "../../static/img/icon_go_more.png";
import { Link } from "react-router-dom";
import ImgLazyLoad from "../../components/imgLazyLoad";
const Brand = ({ brandList }) => {
  if (brandList) {
    return (
      <div className="brandBox">
        <div className="brandTitle">品牌制造商直供</div>
        <div className="brandWrap">
          {brandList.map((item) => (
            <Link
              to={`/brandDetail/${item.id}`}
              className="brandItem"
              key={item.id}
            >
              <div className="brandItemName">{item.name}</div>
              <div className="brandItemMinPrice">{item.floor_price}元起</div>
              <ImgLazyLoad
                offSetTop={0}
                realUrl={item.new_pic_url}
              ></ImgLazyLoad>
            </Link>
          ))}
        </div>
      </div>
    );
  } else {
    return null;
  }
};

const Channel = ({ channel }) => {
  if (channel) {
    return (
      <div className="channelWrap">
        {channel.map((item) => (
          <Link
            className="channelItem"
            to={`/categorys/${item.id}`}
            key={item.id}
          >
            <ImgLazyLoad offSetTop={44} realUrl={item.icon_url}></ImgLazyLoad>
            <div>{item.name}</div>
          </Link>
        ))}
      </div>
    );
  } else {
    return null;
  }
};

const NewGoods = ({ newGoodsList }) => {
  return (
    <div className="newGoodsBox">
      <div className="newGoodsTitle">新品首发</div>
      <div className="newGoodsWrap">
        {newGoodsList.map((item) => (
          <Link to={`/goods/${item.id}`} className="newGoodsItem" key={item.id}>
            <ImgLazyLoad
              offSetTop={44}
              realUrl={item.list_pic_url}
            ></ImgLazyLoad>
            <div className="newGoodsName">{item.name}</div>
            <div className="newGoodsPrice">￥{item.retail_price}</div>
          </Link>
        ))}
      </div>
    </div>
  );
};

const HotGoods = ({ hotGoodsList }) => {
  return (
    <div className="hotGoodsBox">
      <div className="hotGoodsTitle">人气推荐</div>
      <div className="hotGoodsWrap">
        {hotGoodsList.map((item) => (
          <LazyLoad throttle={200} height={300} key={item.id}>
            <Link
              to={`/goods/${item.id}`}
              className="hotGoodsItem"
              key={item.id}
            >
              <ImgLazyLoad
                offSetTop={44}
                realUrl={item.list_pic_url}
              ></ImgLazyLoad>
              <div className="hotGoodsInfos">
                <div className="hotGoodsName">{item.name}</div>
                <div className="hotGoodsInfo">{item.goods_brief}</div>
                <div className="hotGoodsPrice">￥{item.retail_price}</div>
              </div>
            </Link>
          </LazyLoad>
        ))}
      </div>
    </div>
  );
};

const TopGoods = ({ topicList }) => {
  return (
    <div className="topGoodsBox">
      <div className="topGoodsTitle">专题精选</div>
      <div className="topGoodsWrap">
        <Carousel dots={false} infinite slideWidth={0.85} cellSpacing={10}>
          {topicList.map((item) => (
            <Link
              to={`/topicDetail/${item.id}`}
              key={item.id}
              className="topGoodsItem"
            >
              <ImgLazyLoad
                offSetTop={44}
                realUrl={item.item_pic_url}
              ></ImgLazyLoad>
              <div className="topGoodSubTitle">
                {item.title}{" "}
                <span className="topGoodPrice">￥{item.price_info}元起</span>
              </div>
              <div className="topGoodTitle">{item.subtitle}</div>
            </Link>
          ))}
        </Carousel>
      </div>
    </div>
  );
};

const CateGoryGoods = ({ categoryList }) => {
  return (
    <div className="cateGoryBox">
      {categoryList.map((item) => {
        return (
          <LazyLoad throttle={100} height={300} key={item.id}>
            <div className="cateGoryName">{item.name}</div>
            <div className="cateGoryGoodsWrap">
              {item.goodsList.map((item) => {
                return (
                  <Link to={`/goods/${item.id}`} tag="div" key={item.id}>
                    <div className="goodsItemImg">
                      <ImgLazyLoad
                        offSetTop={44}
                        className="goodsItemImg"
                        realUrl={item.list_pic_url}
                      ></ImgLazyLoad>
                    </div>
                    {/*<img src={item.list_pic_url} alt={item.name} className="goodsItemImg"/>*/}
                    <div className="goodsItemName">{item.name}</div>
                    <div className="goodsItemPrice">￥{item.retail_price}</div>
                  </Link>
                );
              })}
              <Link to={`/categorys/${item.id}`} className="categoryMoreGoods">
                <div>更多{item.name}好物</div>
                <img src={morePng} alt="more" />
              </Link>
            </div>
          </LazyLoad>
        );
      })}
    </div>
  );
};

class App extends Component {
  componentDidMount() {
    this.props.actions.fetchData();
  }

  render() {
    const {
      banner,
      newGoodsList,
      channel,
      hotGoodsList,
      brandList,
      topicList,
      categoryList,
    } = this.props;
    return (
      <Fragment>
        <Carousel autoplay infinite>
          {banner.map((item) => (
            <div className="bannerImg" key={item.id}>
              <ImgLazyLoad offSetTop={0} realUrl={item.image_url}></ImgLazyLoad>
            </div>
          ))}
        </Carousel>
        <Channel channel={channel}></Channel>

        <Brand brandList={brandList}></Brand>

        <NewGoods newGoodsList={newGoodsList}></NewGoods>

        <HotGoods hotGoodsList={hotGoodsList}></HotGoods>

        <TopGoods topicList={topicList}></TopGoods>

        <CateGoryGoods categoryList={categoryList}></CateGoryGoods>
      </Fragment>
    );
  }
}
const mapStateToProps = (state, props) => ({ ...state.home });
const mapDispatchToProps = (dispatch) => ({
  actions: bindActionCreators(homeAction, dispatch),
});
export default connect(mapStateToProps, mapDispatchToProps)(App);
