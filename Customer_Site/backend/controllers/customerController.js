// Read-mostly customer endpoints: search, browse (cached), cart view, history,
// favourites, profile. Money-moving flows live in orderController.js.

const db = require('../db/index.js');
const password = require('../lib/password');
const cache = require('../lib/cache');

// Menus and lists change rarely and are read constantly -> cache-aside.
// The canteen backend deletes these keys whenever a dish or discount changes.
const CATALOG_TTL_SECONDS = Number(process.env.CATALOG_CACHE_TTL || 300);


exports.searchCanteen = async (req, res) => {
    try {
        let  canteenNameToSearch  = req.body.canteen_name ;
        //.log("SEARCH") ;
        //.log(req.body.canteen_name) ;
        //.log(canteenNameToSearch) ; 

        // const canteenNameToSearch = canteen_name ; 

        // Validate input
        if (!canteenNameToSearch || typeof canteenNameToSearch !== "string") {
            return res.status(400).json({ error: "Invalid canteen name." });
        }

        canteenNameToSearch = canteenNameToSearch.trim(); // Remove extra spaces

        // PostgreSQL query with case-insensitive search
        // canteen_id,name,rating , img_url, address ye sab chahiye jaha canteen_name = canteenNameToSearch
        const query = `
            SELECT 
                c.canteen_id,
                c.name AS canteen_name,
                c.img_url as img_url,
                c.address as address,
                c.rating as rating
            FROM canteens c
            WHERE c.name = $1;
        `;

        // const query = `
        //     SELECT 
        //         c.canteen_id,
        //         c.name AS canteen_name,
        //         c.opening_time,
        //         c.closing_time,
        //         levenshtein(lower(c.name), lower($1)) AS edit_distance
        //     FROM canteens c
        //     WHERE c.name % $1  -- Trigram filtering for fuzzy matches
        //     ORDER BY edit_distance ASC  -- Prioritize closest matches
        //     LIMIT 5;
        // `;

        const values = [canteenNameToSearch]; // Allow partial matches

        const { rows } = await db.query(query, values);

        // Check if results exist
        if (rows.length === 0) {
            return res.status(404).json({ error: "No matching canteen found." });
        }

        return res.status(200).json({ ok: true, data: rows });
    } 
    catch (error) {
        //.error("Error searching canteen:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
};


exports.searchDish = async (req, res) => {
    try {
        let { dishNameToSearch } = req.body;

        // Validate input
        if (!dishNameToSearch || typeof dishNameToSearch !== "string") {
            return res.status(400).json({ error: "Invalid dish name." });
        }

        dishNameToSearch = dishNameToSearch.trim(); // Remove extra spaces

        // Query using Levenshtein distance for best matching results
        const query = `
            SELECT 
                d.dish_name, 
                d.img_url, 
                d.rating, 
                d.is_veg, 
                d.price, 
                c.name AS canteen_name,
                levenshtein(lower(d.dish_name), lower($1)) AS edit_distance
            FROM dishes d
            JOIN canteens c ON d.canteen_id = c.canteen_id
            WHERE d.dish_name % $1 -- Trigram filtering for speed
            ORDER BY edit_distance ASC  -- Closest match first
            LIMIT 5;
        `;

        const values = [dishNameToSearch];

        const { rows } = await db.query(query, values);

        return res.status(200).json({ success: true, data: rows });
    } 
    catch (error) {
        //.error("Error searching dish:", error);
        return res.status(500).json({ error: "Internal server error." });
    }
};

exports.fetchReservations = async (req, res) => {
    try {
        // const { customer_id } = req.body;
        console.log("RESERVATION HISTORY") ; 
        const customer_id = req.customer_id ; 
        console.log(customer_id) ; 
        
        if (!customer_id) {
            return res.status(400).json({ message: "Customer ID is required" });
        }

        // Query to fetch reservations for the customer
        const query = `
                SELECT 
                r.reservation_id, 
                r.status, 
                r.reservation_time AS time, 
                r.num_people,
                c.name, 
                c.img_url, 
                c.rating,
                c.address
            FROM reservations r
            JOIN canteens c ON r.canteen_id = c.canteen_id
            WHERE r.customer_id = $1;
      
        `;
        const { rows } = await db.query(query, [customer_id]);

        console.log(rows) ; 
        // //.log(rows) ; 
        return res.status(200).json({ reservations: rows });
    } catch (error) {
        return res.status(500).json({
            error: error.message || "Internal Server Error"
        });
    }
};

exports.viewCart = async (req, res) => {
    try {
        const customer_id = req.customer_id ;
        // //.log("MY CART") ; 
        // const { userType } = req.body;

        // //.log(customer_id) ; 

        // if (userType !== "customer") {
        //     return res.status(200).json({
        //         canteen_id: null,
        //         is_delivery: false,
        //         bill_amount: 0,
        //         discount_amount: 0,
        //         final_amount: 0,
        //         dishes: []
        //     });
        // }

        // Get cart_id for the customer
        const query1 = `SELECT cart_id FROM customers WHERE customer_id = $1;`;
        const cartResult = await db.query(query1, [customer_id]);
        // //.log("CART ID " ,cartResult, "CUSTOMER " , customer_id) ; 
        // //.log("MY CART") ;  
        if (cartResult.rowCount === 0 || !cartResult.rows[0].cart_id) {
            return res.status(200).json({
                canteen_id: null,
                is_delivery: false,
                bill_amount: 0,
                discount_amount: 0,
                final_amount: 0,
                dishes: []
            });
        }
        // //.log("MY CART") ; 
        const cart_id = cartResult.rows[0].cart_id;

        // Fetch cart details
        // //.log("MY CART") ; 
        const query2 = `
            SELECT canteen_id, is_delivery, bill_amount, discount_amount, final_amount, dish_map
            FROM orders
            WHERE order_id = $1;
        `;
        const orderResult = await db.query(query2, [cart_id]);

        if (orderResult.rowCount === 0) {
            return res.status(200).json({
                canteen_id: null,
                is_delivery: false,
                bill_amount: 0,
                discount_amount: 0,
                final_amount: 0,
                dishes: []
            });
        }
        // //.log("MY CART") ; 
        const { canteen_id, is_delivery, bill_amount, discount_amount, final_amount, dish_map } = orderResult.rows[0];

        if (!dish_map || Object.keys(dish_map).length === 0) {
            return res.status(200).json({
                canteen_id: null,
                is_delivery: false,
                bill_amount: 0,
                discount_amount: 0,
                final_amount: 0,
                dishes: [],
                dish_map: orderResult.rows[0]?.dish_map || {}
            });
        }

        // Fetch dish details
        const query3 = `
            SELECT dish_name, img_url, rating, price, is_veg, dish_id, dish_tag
            FROM dishes
            WHERE dish_id = ANY($1);
        `;
        const dishResult = await db.query(query3, [Object.keys(dish_map)]);

        // //.log("MY CART") ; 
        // //.log(canteen_id,
        //     is_delivery,
        //     bill_amount,
        //     discount_amount,
        //     final_amount,
        //     dishResult.rows) ;

        return res.status(200).json({
            canteen_id,
            is_delivery,
            bill_amount,
            discount_amount,
            final_amount,
            dishes: dishResult.rows,
            dish_map: orderResult.rows[0]?.dish_map || {}
        });

    } catch (error) {
        return res.status(500).json({
            canteen_id: null,
            is_delivery: false,
            bill_amount: 0,
            discount_amount: 0,
            final_amount: 0,
            dishes: [],
            dish_map: orderResult.rows[0]?.dish_map || {}
        });
    }
};



exports.viewOrderHistory = async (req, res) => {
    try {
        const { type } = req.body;
        const customer_id = req.customer_id;
        // //.log(customer_id);

        // const { customer_id ,type} = req.body ;

        const isDelivery = type === "delivery";

        const ordersQuery = `
            SELECT 
                o.order_id,
                o.time,
                o.dish_map,
                o.is_delivery,
                o.status,
                o.final_amount,
                c.name AS canteen_name,
                c.img_url AS canteen_img_url,
                c.rating AS canteen_rating
            FROM orders o
            JOIN canteens c ON o.canteen_id = c.canteen_id
            WHERE o.customer_id = $1 
            AND o.is_delivery = $2
            AND o.final_amount > 0
            ORDER BY o.time ASC;
        `;

        const ordersResult = await db.query(ordersQuery, [customer_id , isDelivery ]);
        const orders = ordersResult.rows;

        const dishIdSet = new Set();
        const ordersWithParsedDishes = orders.map(order => {
            const dishMap = order.dish_map;
            const parsedDishes = [];

            for (const dishId in dishMap) {
                dishIdSet.add(parseInt(dishId));
                parsedDishes.push({
                    dish_id: parseInt(dishId),
                    quantity: dishMap[dishId]
                });
            }

            return {
                ...order,
                dishes: parsedDishes
            };
        });

        const dishIds = Array.from(dishIdSet);
        let dishDetailsMap = {};
        if (dishIds.length > 0) {
            const dishQuery = `
                SELECT dish_id, dish_name, price 
                FROM dishes 
                WHERE dish_id = ANY($1);
            `;
            const dishResult = await db.query(dishQuery, [dishIds]);
            dishDetailsMap = dishResult.rows.reduce((acc, dish) => {
                acc[dish.dish_id] = dish;
                return acc;
            }, {});
        }

        const finalOrders = ordersWithParsedDishes.map(order => {
            const enrichedItems = order.dishes.map(d => ({
                name: dishDetailsMap[d.dish_id]?.dish_name || "Unknown",
                quantity: d.quantity,
                price: dishDetailsMap[d.dish_id]?.price || 0
            }));

            const subtotal = enrichedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);
            const tax = parseFloat((0.1 * subtotal).toFixed(2));
            const deliveryFee = order.is_delivery ? 30 : 0;
            const discount = 0;
            const total = subtotal + tax + deliveryFee - discount;

            let statusString = "processing";
            if (order.status === 0) statusString = "failed";
            else if (order.status === 4) statusString = "completed";

            return {
                id: `ORD${order.order_id.toString().padStart(3, '0')}`,
                type: order.is_delivery ? "delivery" : "dine-out",
                date: order.time,
                status: statusString,
                restaurant: {
                    name: order.canteen_name,
                    logo: order.canteen_img_url,
                    rating: order.canteen_rating
                },
                items: enrichedItems,
                total: subtotal,
                payment: {
                    subtotal,
                    tax,
                    delivery: deliveryFee,
                    discount,
                    total
                }
            };
        });

        return res.status(200).json({
            message: "Order history retrieved successfully.",
            data: finalOrders,
            success: true,
        });

    } catch (error) {
        //.error("Error in viewOrderHistory:", error);
        return res.status(500).json({
            message: "Error detected",
            success: false,
        });
    }
};



exports.addFavourites = async (req, res) => {
    try {
        const {dish_id } = req.body;
        const customer_id = req.customer_id ;

        const dish_check_query = `SELECT dish_name FROM dishes WHERE dish_id = $1;`;

        const doesDishExist = await db.query(dish_check_query,[dish_id]);

        if(!doesDishExist.rows[0]){
            return res.status(400).json({error: "Dish does not exist"});
        }

        // //.log(doesDishExist.rows[0]);

        if (!customer_id || !dish_id) {
            return res.status(400).json({ error: "Customer ID and Dish ID are required" ,success: false});
        }

        const query = `
            UPDATE customers
            SET favourites = array_append(favourites, $2)
            WHERE customer_id = $1;
        `;

        await db.query(query, [customer_id, dish_id]);

        return res.json({ message: "Dish added to favorites successfully" ,success: true});
    } catch (error) {
        //.error("Error adding favorite dish:", error);
        return res.status(500).json({ error: "Internal Server Error" ,success: false});
    }
};


exports.viewFavourites = async (req, res) => {
    try {
        // const { customer_id } = req.body;
        const customer_id = req.customer_id ;

        // console.log(customer_id) ; 

        //.log(customer_id) ; 

        if (!customer_id) {
            return res.status(400).json({ error: "Customer ID is required" ,success:false});
        }

        // const query = `
        //     SELECT d.dish_name, d.rating, d.is_veg, d.img_url, d.price
        //     FROM dishes d
        //     INNER JOIN favourites f ON d.dish_id = f.dish_id
        //     WHERE f.customer_id = $1;
        // `;

        const query = `
            SELECT d.dish_id ,d.dish_name, d.rating, d.is_veg, d.img_url, d.price
            FROM dishes d
            WHERE d.dish_id = ANY (
                SELECT unnest(favourites)
                FROM customers
                WHERE customer_id = $1
            );
        `;

        const { rows } = await db.query(query, [customer_id]);

        return res.status(200).json({data: rows,success:true});
    } catch (error) {
        console.error("Error fetching customer favorites:", error);
        return res.status(500).json({ error: "Internal Server Error" ,success:false});
    }
};

exports.removeFavourites = async (req, res) => {
    try {
        const customer_id = req.customer_id;
        const { dish_id } = req.body;

        if (!dish_id) {
            return res.status(400).json({ error: "dish_id is required", success: false });
        }

        // Update favourites array by removing the given dish_id
        const query = `
            UPDATE customers
            SET favourites = array_remove(favourites, $1)
            WHERE customer_id = $2
            RETURNING favourites;
        `;

        const result = await db.query(query, [dish_id, customer_id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Customer not found", success: false });
        }

        return res.status(200).json({
            message: "Dish removed from favourites successfully",
            favourites: result.rows[0].favourites,
            success: true
        });

    } catch (error) {
        //.error("Error removing customer favourite:", error);
        return res.status(500).json({ error: "Internal Server Error", success: false });
    }
};

// Customer Wallet
exports.viewWallet = async(req,res) => {
    try {
        // const { customer_id } = req.body;
        const customer_id = req.customer_id ;

        //.log("Customer ID" , customer_id) ; 

        const balance_query = `SELECT wallet_balance FROM customers WHERE customer_id = $1;`;
        const wallet_balance = await db.query(balance_query,[customer_id]);

        const transactions_query = `SELECT * FROM transactions WHERE customer_id = $1 ORDER BY time DESC;`;
        const data = await db.query(transactions_query,[customer_id]);
        
        //.log(data);

        if(!data){
            return res.status(401).json({message:'Data is corrupted',success:false});
        }
        if(!data.rows || data.rows.length === 0){
            return res.status(200).json({message:'User has no transaction till now',success:true, walletBalance:wallet_balance.rows[0].wallet_balance});
        }

        return res.status(200).json({
            message:'Data Acquired',
            data:data.rows,
            balance: wallet_balance,
            success:true
        });
    } catch (error) {
        return res.status(401).json({message:'Some error occured',success:false});
    }
}

// updateWallet


exports.showReservations = async (req, res) => {
    try {
        // const { customer_id } = req.body;
        const customer_id = req.customer_id ;

        // Validate customer_id
        if (!customer_id) {
            return res.status(400).json({
                message: "Customer ID is required!",
                success: false
            });
        }

        // Query to get all reservations for the customer
        const query = `SELECT * FROM reservations WHERE customer_id = $1 ORDER BY reservation_time DESC;`;
        const reservations = await db.query(query, [customer_id]);

        // Check if reservations exist
        if (reservations.rows.length === 0) {
            return res.status(404).json({
                message: "No reservations found for this customer.",
                success: false
            });
        }

        return res.status(200).json({
            message: "Reservations retrieved successfully!",
            success: true,
            reservations: reservations.rows
        });

    } catch (error) {
        //.error(error);
        return res.status(500).json({
            message: "Failed to fetch reservations!",
            success: false
        });
    }
};

exports.viewProfile = async (req, res) => {
    try {
        // const {customer_id}  = req.body; // Assuming customer_id is passed in the request body
        const customer_id = req.customer_id ;
        // //.log(customer_id) ; 
        // //.log(req) ; 
        if (!customer_id) {
            return res.status(400).json({ message: "Customer ID is required", success: false });
        }

        // Fetch customer details
        const customerQuery = `
            SELECT name, username, email, phone_number, wallet_balance, img_url, address
            FROM customers WHERE customer_id = $1;
        `;
        const customerResult = await db.query(customerQuery, [customer_id]);

        // //.log(customerResult) ; 

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ message: "Customer not found", success: false });
        }
        
        const customer = customerResult.rows[0];

        // Fetch order statistics
        const orderStatsQuery = `
            SELECT 
                COUNT(*) AS total_orders,
                COUNT(*) FILTER (WHERE is_delivery = TRUE) AS food_delivery,
                COUNT(*) FILTER (WHERE is_delivery = FALSE) AS dineout
            FROM orders WHERE customer_id = $1;
        `;
        const orderStatsResult = await db.query(orderStatsQuery, [customer_id]);
        const orderStats = orderStatsResult.rows[0] || { total_orders: 0, food_delivery: 0, dineout: 0 };

        // //.log(orderStats) ; 

        // Fetch reservation count (assuming a reservations table exists)
        const reservationQuery = `SELECT COUNT(*) AS total_reservations FROM reservations WHERE customer_id = $1;`;
        const reservationResult = await db.query(reservationQuery, [customer_id]);
        const totalReservations = reservationResult.rows[0].total_reservations || 0;

        return res.status(200).json({
            message: "Profile fetched successfully",
            success: true,
            profile: {
                name: customer.name,
                username: customer.username,
                email: customer.email,
                phone_number: customer.phone_number,
                wallet_balance: customer.wallet_balance,
                img_url: customer.img_url,
                address: customer.address,
                total_orders: parseInt(orderStats.total_orders, 10),
                food_delivery: parseInt(orderStats.food_delivery, 10),
                dineout: parseInt(orderStats.dineout, 10),
                total_reservations: parseInt(totalReservations, 10)
            }
        });

    } catch (error) {
        //.log(error) ; 
        //.error("Error fetching profile:", error);
        return res.status(500).json({ message: "Failed to fetch profile", success: false });
    }
};


exports.fetchTop5 =  async(req,res) => {
     // Query to get top 5 most ordered dishes overall
    try {
        const topDishesQuery = `
                SELECT 
            d.dish_name, 
            c.name AS canteen_name, 
            d.rating, 
            d.is_veg, 
            d.img_url, 
            d.order_count
        FROM dishes d
        JOIN canteens c ON d.canteen_id = c.canteen_id
        WHERE d.is_active = TRUE
        ORDER BY d.order_count DESC
        LIMIT 5;
           ` ;

        // Short TTL: order counts change with every order.
        const rows = await cache.getOrLoad(cache.keys.top5(), 60, async () => (await db.query(topDishesQuery)).rows);

        if (rows.length === 0) {
            return res.status(404).json({ message: "No dishes yet", success: false });
        }
        return res.status(200).json({ message: "Data fetched", success: true, data: rows });
    } catch (error) {
        console.error('[fetchTop5]', error.message);
        return res.status(500).json({ message: "Some error occurred.", success: false });
    }
}


exports.updateProfilePhoto = async (req, res) => {
    //.log("IN PROFILE PHOTO") ;
    try {
        
        const { img_url } = req.body;
        const customer_id = req.customer_id ;
        // const customer_id = req.customer_id; // Middleware se aayega

        //.log(customer_id) ;
        //.log(img_url) ;

        if (!img_url) {
            return res.status(400).json({ message: "Image URL is required" });
        }

        const result = await db.query(
            `UPDATE customers SET img_url = $1 WHERE customer_id = $2 RETURNING img_url;`,
            [img_url, customer_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Customer not found" });
        }

        return res.status(200).json({ message: "Profile photo updated successfully", img_url: result.rows[0].img_url });
    } catch (error) {
        //.error("Error updating profile photo:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { name, phone_number, address } = req.body;
        const customer_id = req.customer_id ;
        // const customer_id = req.customer_id; // Extract customer_id from the request

        // Fetch existing customer data
        const customerQuery = await db.query(
            `SELECT username, password, name, phone_number, address FROM customers WHERE customer_id = $1;`,
            [customer_id]
        );

        if (customerQuery.rows.length === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const existingCustomer = customerQuery.rows[0];

        // Check if phone number is being changed and if it's already taken
        if (phone_number !== existingCustomer.phone_number) {
            const phoneCheck = await db.query(
                `SELECT customer_id FROM customers WHERE phone_number = $1;`,
                [phone_number]
            );
            if (phoneCheck.rows.length !== 0) {
                return res.status(401).json({ message: 'Phone number already taken' });
            }
        }

        // Construct dynamic update query only with changed fields
        let updateFields = [];
        let updateValues = [];
        let paramIndex = 1;

        if (name && name !== existingCustomer.name) {
            updateFields.push(`name = $${paramIndex}`);
            updateValues.push(name);
            paramIndex++;
        }
        if (phone_number && phone_number !== existingCustomer.phone_number) {
            updateFields.push(`phone_number = $${paramIndex}`);
            updateValues.push(phone_number);
            paramIndex++;
        }
        if (address && address !== existingCustomer.address) {
            updateFields.push(`address = $${paramIndex}`);
            updateValues.push(address);
            paramIndex++;
        }

        if (updateFields.length === 0) {
            return res.status(200).json({ message: 'No changes detected' });
        }

        // Append customer_id for the WHERE clause
        updateValues.push(customer_id);
        const updateQuery = `UPDATE customers SET ${updateFields.join(', ')} WHERE customer_id = $${paramIndex};`;

        await db.query(updateQuery, updateValues);

        return res.status(200).json({ message: 'Profile updated successfully' , success:true});
    } catch (error) {
        //.error('Error updating profile:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "Both current and new passwords are required" });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ message: "New password must be at least 8 characters" });
        }

        const user = await db.query("SELECT password FROM customers WHERE customer_id = $1", [req.customer_id]);
        if (user.rows.length === 0) return res.status(404).json({ message: "User not found" });

        if (!(await password.verify(currentPassword, user.rows[0].password))) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        await db.query("UPDATE customers SET password = $1 WHERE customer_id = $2", [
            await password.hash(newPassword),
            req.customer_id,
        ]);

        res.clearCookie("token"); // log out everywhere on this browser
        return res.status(200).json({ success: true, message: "Password changed successfully" });
    } catch (error) {
        console.error("[changePassword]", error.message);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

// ---- Catalog: cache-aside (see lib/cache.js) ----

exports.fetchDishes = async (req, res) => {
    try {
        const rows = await cache.getOrLoad(cache.keys.dishes(), CATALOG_TTL_SECONDS, async () => (await db.query(
            `SELECT d.dish_name, d.img_url, c.name AS canteen_name, d.price, d.is_veg, d.rating, d.dish_id
               FROM dishes d JOIN canteens c ON d.canteen_id = c.canteen_id
              WHERE d.is_active = true`
        )).rows);
        res.json(rows);
    } catch (error) {
        console.error("[fetchDishes]", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

exports.fetchCanteens = async (req, res) => {
    try {
        const rows = await cache.getOrLoad(cache.keys.canteens(), CATALOG_TTL_SECONDS, async () => (await db.query(
            "SELECT name, canteen_id, rating, img_url, address FROM canteens"
        )).rows);
        res.json(rows);
    } catch (error) {
        console.error("[fetchCanteens]", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

exports.fetchMenu = async (req, res) => {
    try {
        const canteenId = Number(req.body.canteen_id);
        if (!Number.isInteger(canteenId) || canteenId <= 0) {
            return res.status(400).json({ error: "canteen_id is required" });
        }
        // Uses the dishes(canteen_id) WHERE is_active index.
        const rows = await cache.getOrLoad(cache.keys.menu(canteenId), CATALOG_TTL_SECONDS, async () => (await db.query(
            `SELECT dish_name, img_url, rating, price, is_veg, dish_id, dish_tag, stock
               FROM dishes WHERE canteen_id = $1 AND is_active = true`,
            [canteenId]
        )).rows);
        res.status(200).json(rows);
    } catch (error) {
        console.error("[fetchMenu]", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

// Customer Stats
// Payment waala
// Pament : Virtual money 



exports.fetchTransactions = async (req, res) => {

    //.log("FETCH TRANSACTIONS IS HIT") ; 

    const customer_id = req.customer_id;
    // const { customer_id} = req.body ; 

    try {
        const result = await db.query(
            `SELECT transaction_id, order_id, customer_id, time, amount 
             FROM transactions 
             WHERE customer_id = $1 
             ORDER BY time DESC`,
            [customer_id]
        );

        // //.log("why" , result.rows) ; 

        return res.status(200).json({
            status: "success",
            transactions: result.rows
        });

    } catch (err) {
        //.error("❌ Error fetching transactions:", err.message);
        return res.status(500).json({ status: "error", message: "Internal server error" });
    }
};

